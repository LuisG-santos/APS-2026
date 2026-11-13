"""Agrega os CSVs de carga e gera gráficos sem reenviar requisições."""

import argparse
import csv
import gzip
import json
import math
import shutil
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np


def percentis(valores):
    if not valores:
        return {"p50_ms": None, "p95_ms": None, "p99_ms": None}
    resultados = np.percentile(valores, [50, 95, 99], method="linear")
    return dict(zip(("p50_ms", "p95_ms", "p99_ms"), map(float, resultados)))


def estatisticas(registros, duracao):
    validas = [float(r["duracao_ms"]) for r in registros if r["resultado"] == "sucesso"]
    falhas = len(registros) - len(validas)
    return {
        "total": len(registros), "sucessos": len(validas), "falhas": falhas,
        "erros_percentual": 100 * falhas / len(registros) if registros else None,
        "conclusoes_por_s": len(registros) / duracao if duracao > 0 else None,
        "sucessos_por_s": len(validas) / duracao if duracao > 0 else None,
        "latencia_media_ms": float(np.mean(validas)) if validas else None,
        "erros": dict(Counter(r["erro"] for r in registros if r["erro"])),
        "por_status": dict(Counter(str(r["status"]) if r.get("status") not in ("", None) else "sem_resposta"
                                   for r in registros)),
        "por_pod": dict(Counter(r["pod"] for r in registros if r.get("pod"))),
        "sem_x_pod": sum(not r.get("pod") for r in registros if r.get("status") not in ("", None)),
        **percentis(validas),
    }


def resumos_degraus(metadata, http, recursos):
    resultado = []
    inicio = 0
    observado = float(metadata.get("fim_http_s", metadata.get("observado_s", 0)))
    for etapa in metadata["etapas"]:
        fim = inicio + etapa["duracao_s"]
        aquecimento = etapa.get("aquecimento_s", 0)
        duracao = max(0, min(fim, observado) - inicio - aquecimento)
        for api in metadata["config"]["apis"]:
            # Pelo início e fim reais: nenhuma resposta atravessando a fronteira é misturada.
            linhas = [r for r in http if r["api"] == api and r.get("etapa") == etapa.get("nome") and
                      inicio + aquecimento <= float(r.get("inicio_s", r["fim_s"])) and
                      float(r["fim_s"]) <= fim]
            if etapa["concorrencia_por_api"] > 0 and duracao > 0:
                amostras = [r for r in recursos if not r["erro"] and
                            r.get("pod", "").startswith("api-" + api + "-") and
                            inicio + aquecimento <= float(r["tempo_s"]) < min(fim, observado)]
                cpus = [float(r["cpu_m"]) for r in amostras if r["cpu_m"] != ""]
                resultado.append({"api": api, "etapa": etapa.get("nome", ""),
                                  "metodo": metadata["config"].get("metodo", "POST"),
                                  "repeticao": etapa.get("repeticao", 1),
                                  "trabalhadores": etapa["concorrencia_por_api"],
                                  "inicio_s": inicio, "fim_s": fim, "duracao_medida_s": duracao,
                                  "aquecimento_s": aquecimento, "completo": observado >= fim,
                                  "cpu_pod_max_m": max(cpus) if cpus else None,
                                  "cpu_pod_media_m": float(np.mean(cpus)) if cpus else None,
                                  **estatisticas(linhas, duracao)})
        inicio = fim
    return resultado


def detectar_saturacao(degraus):
    """Candidatos para revisão, sem atribuir causa ou inferir capacidade máxima."""
    achados = []
    anteriores = {}
    for d in degraus:
        if not d["completo"] or d["total"] < 100:
            anteriores.pop((d["api"], d["repeticao"]), None)
            continue
        chave = d["api"], d["repeticao"]
        anterior = anteriores.get(chave)
        motivos = []
        if d["falhas"]:
            motivos.append("há erros")
        if (anterior and d["trabalhadores"] > anterior["trabalhadores"] and
                d["p95_ms"] is not None and anterior["p95_ms"] is not None):
            if (d["sucessos_por_s"] <= anterior["sucessos_por_s"] * 1.10 and
                    d["p95_ms"] >= anterior["p95_ms"] * 1.50):
                motivos.append("vazão cresceu até 10% e P95 cresceu ao menos 50%")
        if motivos:
            achados.append({"api": d["api"], "repeticao": d["repeticao"],
                            "trabalhadores": d["trabalhadores"], "motivo": "; ".join(motivos),
                            "confirmado": False})
        anteriores[chave] = d
    return achados


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


def calcular_resumo(metadata, http, kubernetes, janela=10.0, recursos=None):
    observado = float(metadata.get("observado_s", 0))
    ultima_resposta = max((float(r["fim_s"]) for r in http), default=0)
    duracao = max(observado, ultima_resposta)
    carga_planejada = sum(e["duracao_s"] for e in metadata["etapas"]
                          if e["concorrencia_por_api"] > 0)
    # Exclui a recuperação sem carga da taxa geral, mas inclui respostas em trânsito.
    fim_http = float(metadata.get("fim_http_s", duracao))
    carga_observada = min(fim_http, carga_planejada) + max(0, ultima_resposta - carga_planejada)
    degraus = resumos_degraus(metadata, http, recursos or [])
    base = metadata["config"].get("perfil") == "base"
    resumo = {
        "run_id": metadata["run_id"], "status": metadata["status"],
        "observado_s": duracao, "carga_observada_s": carga_observada,
        "janela_s": janela, "percentis": "Somente respostas válidas (POST 201 / GET 200); método linear.",
        "avisos": [], "apis": {}, "degraus": degraus,
        "saturacao_candidatos": detectar_saturacao(degraus),
        "causa_saturacao": "Não determinada automaticamente; correlacionar recursos.csv e ambiente.",
    }
    for api in metadata["config"]["apis"]:
        registros = [r for r in http if r["api"] == api]
        medidas = [r for r in registros if r.get("valida_para_degrau") in (1, "1")] if base else registros
        validas = [float(r["duracao_ms"]) for r in medidas if r["resultado"] == "sucesso"]
        tempo_medido = sum(d["duracao_medida_s"] for d in degraus if d["api"] == api) if base else carga_observada
        amostras_k8s = [r for r in kubernetes if r["api"] == api]
        lacunas = sum(bool(r["erro"]) for r in amostras_k8s)
        janelas = agregar(registros, duracao, janela)
        resumo["apis"][api] = {
            **estatisticas(medidas, tempo_medido),
            "total_bruto": len(registros), "descartadas_medicao": len(registros) - len(medidas),
            "amostras_kubernetes": len(amostras_k8s), "lacunas_kubernetes": lacunas,
            "janelas": janelas,
        }
        if len(validas) < 100:
            resumo["avisos"].append(api + ": menos de 100 sucessos; P99 com amostra pequena.")
        if lacunas or not amostras_k8s:
            resumo["avisos"].append(api + ": coleta Kubernetes parcial ou ausente.")
        if resumo["apis"][api]["sem_x_pod"]:
            resumo["avisos"].append(api + ": respostas sem X-Pod; distribuição por pod incompleta.")
    if base:
        resumo["avisos"].append("Base: aquecimento e respostas cruzando degraus excluídos apenas da análise; CSV bruto preservado.")
        if metadata.get("status") not in ("concluido", "com_falhas"):
            resumo["avisos"].append("Linha de base incompleta/invalidada: não afirmar capacidade máxima.")
        elif metadata.get("status") == "com_falhas":
            resumo["avisos"].append("Base concluída com falhas HTTP/coleta: analisar erros e lacunas antes de concluir capacidade.")
    if recursos is not None and (not recursos or any(r["erro"] for r in recursos)):
        resumo["avisos"].append("CPU/memória parcial ou ausente; não é possível concluir o gargalo só pela latência.")
    return resumo


def ler_resultados(pasta):
    with (pasta / "execucao.json").open(encoding="utf-8") as arquivo:
        metadata = json.load(arquivo)
    arquivos = []
    for nome in ("http.csv", "kubernetes.csv"):
        caminho = pasta / nome
        compactado = not caminho.exists() and (pasta / (nome + ".gz")).exists()
        abrir = gzip.open if compactado else open
        with abrir(pasta / (nome + ".gz") if compactado else caminho,
                   "rt", newline="", encoding="utf-8") as arquivo:
            arquivos.append(list(csv.DictReader(arquivo)))
    return metadata, arquivos[0], arquivos[1]


def ler_recursos(pasta):
    caminho = pasta / "recursos.csv"
    if not caminho.exists():
        return []
    with caminho.open(newline="", encoding="utf-8") as arquivo:
        return list(csv.DictReader(arquivo))


def salvar_csv(caminho, linhas, campos=None):
    if campos is None:
        campos = list(linhas[0]) if linhas else ["api", "etapa"]
    with caminho.open("w", newline="", encoding="utf-8") as arquivo:
        writer = csv.DictWriter(arquivo, fieldnames=campos, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(linhas)


def serie_segundos(metadata, http, duracao):
    origem = metadata.get("inicio_carga_utc")
    origem = datetime.fromisoformat(origem.replace("Z", "+00:00")) if origem else None
    serie = []
    for api in metadata["config"]["apis"]:
        registros = [r for r in http if r["api"] == api]
        grupos = [[] for _ in range(math.ceil(duracao))]
        referencias = [[] for _ in grupos]
        for r in registros:
            if grupos:
                grupos[min(int(float(r["fim_s"])), len(grupos)-1)].append(r)
                if r.get("inicio_utc") and r.get("inicio_s") is not None:
                    instante = float(r["inicio_s"])
                    indice = min(int(instante), len(grupos)-1)
                    # Poucas referências do começo de cada segundo evitam parsear milhões de datas.
                    if len(referencias[indice]) < 9 or instante < referencias[indice][-1][0]:
                        referencias[indice].append((instante, r["inicio_utc"]))
                        referencias[indice] = sorted(referencias[indice])[:9]
        origem_atual = origem
        for i, janela in enumerate(agregar(registros, duracao, 1)):
            if referencias[i]:
                ancoras = [datetime.fromisoformat(h.replace("Z", "+00:00")).timestamp() - t
                           for t, h in referencias[i]]
                origem_atual = datetime.fromtimestamp(float(np.median(ancoras)), timezone.utc)
            inicio = 0
            etapa = None
            for e in metadata["etapas"]:
                if inicio <= janela["inicio_s"] < inicio + e["duracao_s"]:
                    etapa = e
                    break
                inicio += e["duracao_s"]
            serie.append({"api": api,
                          "hora_utc": (origem_atual + timedelta(seconds=janela["inicio_s"])).isoformat() if origem_atual else "",
                          "fonte_hora_utc": "inicios_http" if referencias[i] else "estimada_sem_inicio_http",
                          "desvio_relogio_s": (origem_atual-origem).total_seconds() if origem_atual and origem else None,
                          "trabalhadores": etapa["concorrencia_por_api"] if etapa else 0,
                          "etapa": etapa.get("nome", "") if etapa else "finalizacao",
                          "pods_distintos": len({r["pod"] for r in grupos[i] if r.get("pod")}),
                          **janela})
    return serie


def salvar_resumo(pasta, metadata, http, kubernetes, janela=10.0):
    resumo = calcular_resumo(metadata, http, kubernetes, janela, ler_recursos(pasta))
    (pasta / "resumo.json").write_text(
        json.dumps(resumo, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
    salvar_csv(pasta / "degraus.csv", resumo["degraus"])
    serie = serie_segundos(metadata, http, resumo["observado_s"])
    salvar_csv(pasta / "serie-segundos.csv", serie, ["api", "hora_utc", "fonte_hora_utc", "desvio_relogio_s", "inicio_s", "fim_s",
               "trabalhadores", "etapa", "total", "sucessos", "falhas", "sucessos_por_s",
               "erros_percentual", "p50_ms", "p95_ms", "p99_ms", "pods_distintos"])
    salvar_analise(pasta, metadata, resumo)
    return resumo


def salvar_analise(pasta, metadata, resumo):
    caminho = pasta / "analise.md"
    # A análise é completada pelo grupo; regenerar gráficos não apaga suas anotações.
    if caminho.exists():
        return
    texto = ["# Análise da execução " + metadata["run_id"], "",
             "Comando: `" + metadata.get("comando", "não registrado nesta versão") + "`", "",
             "Estado da execução: " + metadata["status"], "",
             "## Resultados por degrau", "",
             "| API | Repetição | Trabalhadores | Medidos | OK/s | P50 ms | P95 ms | P99 ms | Erros % | CPU máxima m |",
             "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
    for d in resumo["degraus"]:
        def fmt(valor):
            return "—" if valor is None else str(round(valor, 2)) if isinstance(valor, float) else str(valor)
        texto.append("| " + " | ".join(fmt(d[k]) for k in ("api", "repeticao", "trabalhadores", "total",
                     "sucessos_por_s", "p50_ms", "p95_ms", "p99_ms", "erros_percentual", "cpu_pod_max_m")) + " |")
    texto += ["", "## Conclusões a preencher com evidências", "",
              "- Ponto de saturação: não confirmado. Comparar P95, vazão e erros entre degraus e repetições.",
              "- Recurso limitante: não determinado automaticamente. Comparar CPU com o limite registrado em kubernetes.csv; inspecionar também banco, fila/cache e máquina.",
              "- Limite do gerador: conferir uso da máquina e se trabalhadores ≈ vazão × latência média em segundos (aproximação em regime estável e sem erros).",
              "- Frase de referência: com uma réplica, ___ trabalhadores, ___ OK/s, P95 ___ ms e ___% de erros. Evidência do gargalo: ___.",
              "- Variação entre repetições e condições do ambiente: ___.", "",
              "Os candidatos abaixo são apenas heurísticos; erros de rede também podem causar degradação.", "",
              "```json", json.dumps(resumo["saturacao_candidatos"], ensure_ascii=False, indent=2), "```", ""]
    caminho.write_text("\n".join(texto), encoding="utf-8")


def publicar(pasta, destino, limite_compressao=20 * 1024**2):
    """Copia somente os artefatos conhecidos desta execução, sem incluir credenciais."""
    destino.mkdir(parents=True, exist_ok=False)
    nomes = {"execucao.json", "resumo.json", "http.csv", "http.csv.gz", "kubernetes.csv", "recursos.csv",
             "serie-segundos.csv", "degraus.csv", "janelas.csv", "relatorio.pdf", "analise.md",
             "gerador.csv", "cgroups.csv"}
    apis = json.loads((pasta / "execucao.json").read_text(encoding="utf-8"))["config"]["apis"]
    nomes.update(api + sufixo for api in apis for sufixo in (".png", "-por-carga.png"))
    for nome in sorted(nomes):
        if (pasta / nome).is_file():
            if nome == "http.csv" and (pasta / nome).stat().st_size >= limite_compressao:
                # CSV bruto preservado localmente; publicação sem perder nenhuma linha.
                with (pasta / nome).open("rb") as origem, gzip.open(destino / (nome + ".gz"), "wb") as saida:
                    shutil.copyfileobj(origem, saida)
            else:
                shutil.copy2(pasta / nome, destino / nome)


def figura_por_carga(plt, api, resumo):
    dados = [d for d in resumo["degraus"] if d["api"] == api and d["total"] and d["completo"]]
    if not dados:
        return None
    fig, eixos = plt.subplots(2, 1, figsize=(10, 8), sharex=True, layout="constrained")
    fig.suptitle(api + " | latência e vazão por nível de carga\n" + resumo["run_id"] +
                 " | " + resumo["status"] + "\nCada linha representa uma repetição; aquecimento descartado", fontsize=12)
    repeticoes = sorted({d["repeticao"] for d in dados})
    estilos = ["-", "--", ":", "-."]
    for i, repeticao in enumerate(repeticoes):
        pontos = sorted([d for d in dados if d["repeticao"] == repeticao], key=lambda d: d["trabalhadores"])
        x = [d["trabalhadores"] for d in pontos]
        for campo, cor, rotulo in [("p50_ms", "#2878b5", "P50"), ("p95_ms", "#de8f05", "P95"),
                                   ("p99_ms", "#c44e52", "P99")]:
            eixos[0].plot(x, [d[campo] for d in pontos], marker=".", linestyle=estilos[i % 4],
                           color=cor, label=rotulo if i == 0 else None)
        eixos[1].plot(x, [d["sucessos_por_s"] for d in pontos], marker=".",
                      linestyle=estilos[i % 4], label="Repetição " + str(repeticao))
    candidatos = [c["trabalhadores"] for c in resumo["saturacao_candidatos"] if c["api"] == api]
    if candidatos:
        for eixo in eixos:
            eixo.axvspan(min(candidatos), max(d["trabalhadores"] for d in dados), color="#e8dfc8", alpha=.5)
            eixo.axvline(min(candidatos), color="#8b7442", linestyle=":", linewidth=1.2,
                         label="Possível degradação; revisar evidências")
    else:
        eixos[1].text(.02, .04, "Saturação não identificada automaticamente neste conjunto.",
                      transform=eixos[1].transAxes, fontsize=9)
    eixos[0].set_ylabel("Latência (ms)")
    eixos[1].set_ylabel("Respostas válidas/s")
    eixos[1].set_xlabel("Trabalhadores por API (concorrência)")
    eixos[1].set_xscale("log", base=2)
    niveis = sorted({d["trabalhadores"] for d in dados})
    eixos[1].set_xticks(niveis, labels=list(map(str, niveis)))
    for eixo in eixos:
        eixo.set_ylim(bottom=0)
        eixo.grid(alpha=.25)
        eixo.legend(fontsize=8)
    return fig


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
            brutas = [r for r in http if r["api"] == api]
            n_ok = sum(r["resultado"] == "sucesso" for r in brutas)
            fig.suptitle(
                "{} | {} | {}\nCSV completo: {} tentativas; {} sucessos; {} falhas; status: {}".format(
                    api, metadata["config"].get("metodo", "POST"), metadata["run_id"],
                    len(brutas), n_ok, len(brutas) - n_ok, metadata["status"]), fontsize=12)
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
            eixos[0].set_title("Latência (respostas válidas) | n por janela: " + amostras + parcial,
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
                if etapa.get("aquecimento_s", 0) and inicio < duracao:
                    for eixo in eixos:
                        eixo.axvspan(inicio, min(inicio + etapa["aquecimento_s"], duracao),
                                     color="#cccccc", alpha=.35)
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
            figura_carga = figura_por_carga(plt, api, resumo)
            if figura_carga is not None:
                figura_carga.savefig(pasta / (api + "-por-carga.png"), dpi=150)
                pdf.savefig(figura_carga)
                plt.close(figura_carga)
    return resumo


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pasta", type=Path, help="Pasta de uma execução já coletada.")
    parser.add_argument("--janela", type=float, default=10, help="Janela de agregação em segundos.")
    parser.add_argument("--publicar", type=Path, help="Copia os resultados para uma pasta nova, versionável no Git.")
    args = parser.parse_args()
    if not math.isfinite(args.janela) or args.janela <= 0:
        parser.error("--janela deve ser positiva e finita.")
    gerar(args.pasta, args.janela)
    if args.publicar:
        try:
            publicar(args.pasta, args.publicar)
        except FileExistsError:
            parser.error("A pasta de publicação já existe; escolha outra para preservar evidências.")
    print("Gráficos PNG e relatorio.pdf gerados em", args.pasta)


if __name__ == "__main__":
    main()
