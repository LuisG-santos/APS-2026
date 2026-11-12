"""Agrega os CSVs de carga e gera gráficos sem reenviar requisições."""

import argparse
import csv
import json
import math
from collections import Counter
from pathlib import Path

import numpy as np


def percentis(valores):
    if not valores:
        return {"p50_ms": None, "p95_ms": None, "p99_ms": None}
    resultados = np.percentile(valores, [50, 95, 99], method="linear")
    return dict(zip(("p50_ms", "p95_ms", "p99_ms"), map(float, resultados)))


def agregar(linhas, duracao, janela=10.0):
    """As conclusões pertencem a janelas [início, fim); a última pode ser menor."""
    if janela <= 0 or not math.isfinite(janela):
        raise ValueError("A janela deve ser positiva e finita.")
    if duracao <= 0:
        return []
    grupos = [[] for _ in range(math.ceil(duracao / janela))]
    for linha in linhas:
        instante = float(linha["fim_s"])
        if not 0 <= instante <= duracao:
            raise ValueError("Conclusão fora da duração observada.")
        indice = min(int(instante / janela), len(grupos) - 1)
        grupos[indice].append(linha)
    resultado = []
    for indice, grupo in enumerate(grupos):
        inicio, fim = indice * janela, min((indice + 1) * janela, duracao)
        validas = [float(r["duracao_ms"]) for r in grupo if r["resultado"] == "sucesso"]
        falhas = len(grupo) - len(validas)
        resultado.append({
            "inicio_s": inicio, "fim_s": fim, "total": len(grupo),
            "sucessos": len(validas), "falhas": falhas,
            "sucessos_por_s": len(validas) / (fim - inicio),
            "falhas_por_s": falhas / (fim - inicio),
            "erros_percentual": 100 * falhas / len(grupo) if grupo else None,
            "amostra_pequena": 0 < len(validas) < 100,
            **percentis(validas),
        })
    return resultado


def calcular_resumo(metadata, http, kubernetes, janela=10.0):
    observado = float(metadata.get("observado_s", 0))
    ultima_resposta = max((float(r["fim_s"]) for r in http), default=0)
    duracao = max(observado, ultima_resposta)
    carga_planejada = sum(e["duracao_s"] for e in metadata["etapas"]
                          if e["concorrencia_por_api"] > 0)
    # Exclui a recuperação sem carga da taxa geral, mas inclui respostas em trânsito.
    carga_observada = min(duracao, carga_planejada) + max(0, ultima_resposta - carga_planejada)
    resumo = {
        "run_id": metadata["run_id"], "status": metadata["status"],
        "observado_s": duracao, "carga_observada_s": carga_observada,
        "janela_s": janela, "percentis": "Somente respostas 201 válidas; método linear.",
        "avisos": [], "apis": {},
    }
    for api in metadata["config"]["apis"]:
        registros = [r for r in http if r["api"] == api]
        validas = [float(r["duracao_ms"]) for r in registros if r["resultado"] == "sucesso"]
        falhas = len(registros) - len(validas)
        amostras_k8s = [r for r in kubernetes if r["api"] == api]
        lacunas = sum(bool(r["erro"]) for r in amostras_k8s)
        janelas = agregar(registros, duracao, janela)
        resumo["apis"][api] = {
            "total": len(registros), "sucessos": len(validas), "falhas": falhas,
            "erros_percentual": 100 * falhas / len(registros) if registros else None,
            "conclusoes_por_s": len(registros) / carga_observada if carga_observada else None,
            "sucessos_por_s": len(validas) / carga_observada if carga_observada else None,
            "erros": dict(Counter(r["erro"] for r in registros if r["erro"])),
            "amostras_kubernetes": len(amostras_k8s), "lacunas_kubernetes": lacunas,
            **percentis(validas), "janelas": janelas,
        }
        if len(validas) < 100:
            resumo["avisos"].append(api + ": menos de 100 sucessos; P99 com amostra pequena.")
        if lacunas or not amostras_k8s:
            resumo["avisos"].append(api + ": coleta Kubernetes parcial ou ausente.")
    return resumo


def ler_resultados(pasta):
    with (pasta / "execucao.json").open(encoding="utf-8") as arquivo:
        metadata = json.load(arquivo)
    arquivos = []
    for nome in ("http.csv", "kubernetes.csv"):
        with (pasta / nome).open(newline="", encoding="utf-8") as arquivo:
            arquivos.append(list(csv.DictReader(arquivo)))
    return metadata, arquivos[0], arquivos[1]


def salvar_resumo(pasta, metadata, http, kubernetes, janela=10.0):
    resumo = calcular_resumo(metadata, http, kubernetes, janela)
    (pasta / "resumo.json").write_text(
        json.dumps(resumo, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
    return resumo


def gerar(pasta, janela=10.0):
    # Backend sem janela gráfica: funciona em terminal, CI e servidores.
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.backends.backend_pdf import PdfPages
    from matplotlib.ticker import MaxNLocator

    metadata, http, kubernetes = ler_resultados(pasta)
    resumo = salvar_resumo(pasta, metadata, http, kubernetes, janela)
    duracao = resumo["observado_s"]
    campos_janela = ["api", "inicio_s", "fim_s", "total", "sucessos", "falhas",
                     "p50_ms", "p95_ms", "p99_ms", "sucessos_por_s", "falhas_por_s",
                     "erros_percentual", "amostra_pequena"]
    with (pasta / "janelas.csv").open("w", newline="", encoding="utf-8") as arquivo:
        writer = csv.DictWriter(arquivo, fieldnames=campos_janela)
        writer.writeheader()
        for api, dados in resumo["apis"].items():
            for linha in dados["janelas"]:
                writer.writerow({"api": api, **linha})

    def numero(valor):
        return float(valor) if valor not in ("", None) else np.nan

    with PdfPages(pasta / "relatorio.pdf") as pdf:
        for api, dados in resumo["apis"].items():
            fig, eixos = plt.subplots(4, 1, figsize=(11.7, 12), sharex=True,
                                      layout="constrained")
            fig.suptitle(
                "{} | POST de leituras | {}\n{} tentativas; {} sucessos; {} falhas; status: {}".format(
                    api, metadata["run_id"], dados["total"], dados["sucessos"],
                    dados["falhas"], metadata["status"]), fontsize=13)
            grupos = dados["janelas"]
            x = [(j["inicio_s"] + j["fim_s"]) / 2 for j in grupos]
            for campo, rotulo, cor in [
                ("p50_ms", "P50", "#2878b5"), ("p95_ms", "P95", "#de8f05"),
                ("p99_ms", "P99", "#c44e52"),
            ]:
                eixos[0].plot(x, [numero(j[campo]) for j in grupos], ".-",
                               label=rotulo, color=cor)
            pequenas = [j for j in grupos if j["amostra_pequena"]]
            if pequenas:
                eixos[0].scatter(
                    [(j["inicio_s"] + j["fim_s"]) / 2 for j in pequenas],
                    [j["p99_ms"] for j in pequenas], marker="x", s=70, color="black",
                    label="P99: menos de 100 sucessos")
            contagens = [j["sucessos"] for j in grupos]
            amostras = ("/".join(map(str, contagens)) if len(contagens) <= 12 else
                        "mín. {}, máx. {} (detalhes em janelas.csv)".format(
                            min(contagens), max(contagens)))
            parcial = ""
            if grupos and grupos[-1]["fim_s"] - grupos[-1]["inicio_s"] < janela - 1e-6:
                parcial = " | última janela: {:.3f} s".format(
                    grupos[-1]["fim_s"] - grupos[-1]["inicio_s"])
            eixos[0].set_title("Latência (201 válidos) | n por janela: " + amostras + parcial,
                               fontsize=10)
            eixos[0].set_ylabel("Latência (ms)")
            eixos[0].legend(loc="upper left", fontsize=8)
            for campo, rotulo, cor in [
                ("sucessos_por_s", "Sucessos", "#2878b5"),
                ("falhas_por_s", "Falhas", "#c44e52"),
            ]:
                eixos[1].plot(x, [j[campo] for j in grupos], ".-", label=rotulo, color=cor)
            eixos[1].set_title("Requisições concluídas por segundo", fontsize=10)
            eixos[1].set_ylabel("Requisições/s")
            eixos[1].legend(loc="upper left", fontsize=8)
            eixos[2].plot(x, [numero(j["erros_percentual"]) for j in grupos],
                          ".-", color="#c44e52")
            eixos[2].set_title("Erros HTTP, validação, conexão e timeout", fontsize=10)
            eixos[2].set_ylabel("Falhas (%)")
            eixos[2].set_ylim(-2, 102)
            amostras_k8s = [r for r in kubernetes if r["api"] == api]
            for campo, rotulo, cor in [
                ("replicas_desejadas", "Desejadas", "#de8f05"),
                ("replicas_prontas", "Prontas", "#2878b5"),
            ]:
                eixos[3].step(
                    [float(r["tempo_s"]) for r in amostras_k8s],
                    [np.nan if r["erro"] else numero(r[campo]) for r in amostras_k8s],
                    where="post", label=rotulo, color=cor)
            eixos[3].set_title("Réplicas | lacunas de coleta: {}".format(dados["lacunas_kubernetes"]),
                               fontsize=10)
            eixos[3].set_ylabel("Pods")
            eixos[3].set_xlabel("Tempo desde o início da carga (s)")
            eixos[3].yaxis.set_major_locator(MaxNLocator(integer=True))
            eixos[3].legend(loc="upper left", fontsize=8)
            if not dados["sucessos"]:
                eixos[0].text(.5, .5, "Sem respostas válidas: percentis indisponíveis",
                              transform=eixos[0].transAxes, ha="center")
            if not amostras_k8s or all(r["erro"] for r in amostras_k8s):
                eixos[3].text(.5, .5, "Coleta de réplicas indisponível",
                              transform=eixos[3].transAxes, ha="center")
            inicio = 0
            for etapa in metadata["etapas"]:
                fim = inicio + etapa["duracao_s"]
                if etapa["concorrencia_por_api"] == 0:
                    for eixo in eixos:
                        eixo.axvspan(inicio, min(fim, duracao), color="#e8dfc8", alpha=.45)
                elif inicio > 0 and inicio < duracao:
                    for eixo in eixos:
                        eixo.axvline(inicio, color="gray", linestyle=":", linewidth=.8)
                inicio = fim
            fim_envios = sum(e["duracao_s"] for e in metadata["etapas"]
                             if e["concorrencia_por_api"] > 0)
            if 0 < fim_envios < duracao:
                for eixo in eixos:
                    eixo.axvline(fim_envios, color="#555555", linestyle="--", linewidth=.8)
                eixos[1].annotate(
                    "Fim dos novos envios", xy=(fim_envios, .95), xycoords=("data", "axes fraction"),
                    xytext=(-5, 0), textcoords="offset points", ha="right", va="top", fontsize=8)
            for eixo in eixos:
                eixo.grid(alpha=.25)
                eixo.set_xlim(0, max(duracao, 1))
            eixos[0].set_ylim(bottom=0)
            eixos[1].set_ylim(bottom=0)
            eixos[3].set_ylim(bottom=0)
            fig.savefig(pasta / (api + ".png"), dpi=150)
            pdf.savefig(fig)
            plt.close(fig)
    return resumo


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pasta", type=Path, help="Pasta de uma execução já coletada.")
    parser.add_argument("--janela", type=float, default=10, help="Janela de agregação em segundos.")
    args = parser.parse_args()
    if not math.isfinite(args.janela) or args.janela <= 0:
        parser.error("--janela deve ser positiva e finita.")
    gerar(args.pasta, args.janela)
    print("Gráficos PNG e relatorio.pdf gerados em", args.pasta)


if __name__ == "__main__":
    main()
