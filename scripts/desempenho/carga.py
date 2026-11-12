"""Envia leituras concorrentes e registra HTTP e réplicas, sem alterar o cluster."""

import argparse
import csv
import http.client
import json
import math
import signal
import socket
import subprocess
import sys
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

from graficos import ler_resultados, salvar_resumo


APIS = {
    "alagamento": {
        "deployment": "api-alagamento",
        "medidas": [
            ("NIVEL_CORREGO", "nivelCorregoCm", 120.5),
            ("PLUVIOMETRO", "chuvaAcumuladaMm", 35.2),
            ("NIVEL_VIA", "nivelAguaViaCm", 8.0),
        ],
    },
    "qualidade-ar": {
        "deployment": "api-qualidade-ar",
        "medidas": [
            ("MP25", "mp25", 20.0), ("CO", "co", 0.8),
            ("NO2", "no2", 12.4), ("TEMPERATURA", "temperatura", 27.5),
        ],
    },
    "transito": {
        "deployment": "api-transito",
        "medidas": [
            ("RADAR", "velocidade", 42.5),
            ("GPS", "posicao", "-23.5505,-46.6333"), ("OCUPACAO", "ocupacao", 0.75),
        ],
    },
}
HTTP_COLUNAS = ["api", "tipo_sensor", "etapa", "inicio_utc", "inicio_s", "fim_s",
                "duracao_ms", "status", "resultado", "erro", "leitura_id"]
K8S_COLUNAS = ["tempo_s", "api", "replicas_desejadas", "replicas_atuais",
               "replicas_prontas", "cpu_percentual", "erro"]


def agora():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def data_iso(valor):
    if not isinstance(valor, str):
        return None
    try:
        data = datetime.fromisoformat(valor.replace("Z", "+00:00"))
        return data if data.tzinfo is not None else None
    except ValueError:
        return None


def id_valido(valor):
    return type(valor) is int and 0 < valor <= 2147483647


class ClienteHTTP:
    """Uma conexão por trabalhador. Nunca repete a requisição que falhou."""

    def __init__(self, base_url, timeout=10):
        url = urlsplit(base_url)
        if (url.scheme not in ("http", "https") or not url.hostname or
                url.username or url.password or url.query or url.fragment):
            raise ValueError("Use uma URL HTTP(S) sem credenciais, query ou fragmento.")
        self.prefixo = url.path.rstrip("/")
        classe = http.client.HTTPSConnection if url.scheme == "https" else http.client.HTTPConnection
        self.conexao = classe(url.hostname, url.port, timeout=timeout)

    def enviar(self, metodo, caminho, dados=None):
        corpo = json.dumps(dados, allow_nan=False).encode("utf-8") if dados is not None else None
        try:
            self.conexao.request(metodo, self.prefixo + caminho, body=corpo,
                                  headers={"Content-Type": "application/json", "Accept": "application/json"})
            resposta = self.conexao.getresponse()
            conteudo = resposta.read()  # Precisa terminar antes de reutilizar a conexão.
            return resposta.status, conteudo
        except (OSError, http.client.HTTPException):
            self.conexao.close()
            raise

    def fechar(self):
        self.conexao.close()


def validar_leitura(conteudo, sensor, dados, api):
    try:
        leitura = json.loads(conteudo)
    except (ValueError, UnicodeError):
        return False, ""
    if not isinstance(leitura, dict):
        return False, ""
    leitura_id = leitura.get("id")
    valido = (
        id_valido(leitura_id) and type(leitura.get("sensorId")) is int and
        leitura["sensorId"] == sensor["id"] and
        data_iso(leitura.get("createdAt")) is not None and
        data_iso(leitura.get("timestamp")) == data_iso(dados["timestamp"]) and
        isinstance(leitura.get("sensor"), dict) and
        leitura["sensor"].get("id") == sensor["id"] and
        leitura["sensor"].get("tipo") == sensor["tipo"]
    )
    for _, campo, _ in APIS[api]["medidas"]:
        if campo == sensor["campo"]:
            valor = leitura.get(campo)
            tipo_correto = (isinstance(valor, str) if isinstance(dados[campo], str) else
                            type(valor) in (int, float) and math.isfinite(valor))
            valido = valido and tipo_correto and valor == dados[campo]
        else:
            valido = valido and campo in leitura and leitura[campo] is None
    return bool(valido), leitura_id if id_valido(leitura_id) else ""


def medir_leitura(cliente, api, sensor, etapa, origem):
    dados = {"sensorId": sensor["id"], "timestamp": agora(), sensor["campo"]: sensor["valor"]}
    inicio_utc = agora()
    inicio = time.perf_counter()
    status, conteudo, erro = "", b"", ""
    try:
        status, conteudo = cliente.enviar("POST", "/" + api + "/send/" + api, dados)
    except (socket.timeout, TimeoutError):
        erro = "timeout"
    except (OSError, http.client.HTTPException):
        erro = "conexao"
    fim = time.perf_counter()  # Inclui conexão/envio/leitura; não inclui CSV nem validação JSON.
    valido, leitura_id = False, ""
    if not erro:
        if status != 201:
            erro = "http_" + str(status)
        else:
            valido, leitura_id = validar_leitura(conteudo, sensor, dados, api)
            if not valido:
                erro = "validacao"
    return {
        "api": api, "tipo_sensor": sensor["tipo"], "etapa": etapa,
        "inicio_utc": inicio_utc, "inicio_s": inicio - origem, "fim_s": fim - origem,
        "duracao_ms": (fim - inicio) * 1000, "status": status,
        "resultado": "sucesso" if valido else "falha", "erro": erro, "leitura_id": leitura_id,
    }


def consultar_kubernetes(contexto, namespace, apis):
    comando = ["kubectl", "--context", contexto, "--request-timeout=3s",
               "get", "deployment,hpa", "-n", namespace, "-o", "json"]
    try:
        resposta = subprocess.run(comando, capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.TimeoutExpired) as erro:
        raise RuntimeError("Consulta Kubernetes falhou: " + type(erro).__name__) from None
    if resposta.returncode:
        # Não grava stderr, kubeconfig nem o JSON completo de Deployments.
        raise RuntimeError("kubectl falhou; confira contexto, namespace e permissões de leitura.")
    try:
        objetos = json.loads(resposta.stdout)["items"]
        indice = {(obj["kind"], obj["metadata"]["name"]): obj for obj in objetos}
        linhas = []
        for api in apis:
            nome = APIS[api]["deployment"]
            deployment = indice.get(("Deployment", nome))
            hpa = indice.get(("HorizontalPodAutoscaler", nome))
            if deployment is None or hpa is None:
                linhas.append({"api": api, "erro": "Deployment ou HPA ausente",
                               **{k: "" for k in K8S_COLUNAS[2:-1]}})
                continue
            status = deployment.get("status", {})
            cpu = next((
                m.get("resource", {}).get("current", {}).get("averageUtilization", "")
                for m in hpa.get("status", {}).get("currentMetrics", [])
                if m.get("resource", {}).get("name") == "cpu"), "")
            linhas.append({
                "api": api, "replicas_desejadas": deployment["spec"].get("replicas", 1),
                "replicas_atuais": status.get("replicas", 0),
                "replicas_prontas": status.get("readyReplicas", 0),
                "cpu_percentual": cpu, "erro": "",
            })
        return linhas
    except (ValueError, KeyError, TypeError):
        raise RuntimeError("Resposta Kubernetes inválida.") from None


def preparar_sensores(cliente, apis, run_id, interromper, registrar):
    sensores = {}
    for api in apis:
        if interromper.is_set():
            raise InterruptedError()
        status, conteudo = cliente.enviar("GET", "/" + api + "/health/ready")
        resposta = json.loads(conteudo)
        if status != 200 or not isinstance(resposta, dict) or resposta.get("status") != "ready":
            raise RuntimeError("Readiness indisponível: " + api)
    for api in apis:
        sensores[api] = []
        for tipo, campo, valor in APIS[api]["medidas"]:
            if interromper.is_set():
                raise InterruptedError()
            nome = "carga-" + run_id + "-" + api + "-" + tipo.lower()
            dados = {"nome": nome, "tipo": tipo}
            if api == "qualidade-ar":
                dados["estacao"] = "carga-" + run_id
            status, conteudo = cliente.enviar("POST", "/" + api + "/send/sensor", dados)
            if status != 201:
                raise RuntimeError("Cadastro de sensor falhou: " + api + "/" + tipo)
            sensor = json.loads(conteudo)
            if (not isinstance(sensor, dict) or not id_valido(sensor.get("id")) or
                    any(sensor.get(k) != v for k, v in dados.items())):
                raise RuntimeError("Cadastro retornou sensor incompatível: " + api + "/" + tipo)
            sensores[api].append({**dados, "id": sensor["id"], "campo": campo, "valor": valor})
            registrar(sensores)
    return sensores


def etapas_perfil(perfil, duracao=30, concorrencia=2):
    if perfil == "curto":
        return [{"nome": "curto", "duracao_s": duracao, "concorrencia_por_api": concorrencia}]
    return [{"nome": "carga-" + str(n), "duracao_s": 120, "concorrencia_por_api": n}
            for n in (2, 8, 16)] + [
                {"nome": "recuperacao", "duracao_s": 180, "concorrencia_por_api": 0}]


def etapa_atual(etapas, decorrido):
    fim = 0
    for etapa in etapas:
        fim += etapa["duracao_s"]
        if decorrido < fim:
            return etapa
    return None


def salvar_json(caminho, dados):
    temporario = caminho.with_suffix(".tmp")
    temporario.write_text(json.dumps(dados, indent=2, ensure_ascii=False, allow_nan=False),
                          encoding="utf-8")
    temporario.replace(caminho)


def executar(args, interromper=None, consulta_k8s=consultar_kubernetes, intervalo=5):
    interromper = interromper if interromper is not None else threading.Event()
    apis = list(APIS) if args.api == "todas" else [args.api]
    etapas = etapas_perfil(args.perfil, args.duracao, args.concorrencia)
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8]
    pasta = Path(args.saida) if args.saida else Path("evidencias/desempenho") / run_id
    pasta.mkdir(parents=True, exist_ok=False)
    metadata = {
        "versao": 1, "run_id": run_id, "status": "preparando", "inicio_utc": agora(),
        "observado_s": 0, "etapas": etapas, "sensores": {},
        "config": {"apis": apis, "base_url": args.base_url, "perfil": args.perfil,
                   "contexto": args.contexto, "namespace": args.namespace,
                   "timeout_s": args.timeout, "intervalo_k8s_s": intervalo,
                   "modelo": "Concorrência fixa por API em cada etapa; sem retries de POST."},
    }
    caminho_metadata = pasta / "execucao.json"
    salvar_json(caminho_metadata, metadata)
    cliente = ClienteHTTP(args.base_url, args.timeout)
    lock = threading.Lock()
    iniciar = threading.Event()
    terminar_coleta = threading.Event()
    origem = [0.0]
    contadores = {"sucesso": 0, "falha": 0, "lacunas": 0}
    codigo = 1
    with (pasta / "http.csv").open("w", newline="", encoding="utf-8") as arquivo_http, \
            (pasta / "kubernetes.csv").open("w", newline="", encoding="utf-8") as arquivo_k8s:
        http_writer = csv.DictWriter(arquivo_http, fieldnames=HTTP_COLUNAS)
        k8s_writer = csv.DictWriter(arquivo_k8s, fieldnames=K8S_COLUNAS)
        http_writer.writeheader()
        k8s_writer.writeheader()
        try:
            inicial = consulta_k8s(args.contexto, args.namespace, apis)
            if (len(inicial) != len(apis) or
                    any(r["erro"] or r["replicas_prontas"] < 1 for r in inicial)):
                raise RuntimeError("APIs/HPAs ausentes ou sem réplicas prontas no contexto informado.")
            metadata["kubernetes_inicial"] = inicial

            def registrar(sensores):
                metadata["sensores"] = sensores
                salvar_json(caminho_metadata, metadata)

            sensores = preparar_sensores(cliente, apis, run_id, interromper, registrar)

            def trabalhador(api, indice):
                conexao = ClienteHTTP(args.base_url, args.timeout)
                contador = indice
                iniciar.wait()
                try:
                    while not interromper.is_set():
                        etapa = etapa_atual(etapas, time.perf_counter() - origem[0])
                        if etapa is None:
                            return
                        if indice >= etapa["concorrencia_por_api"]:
                            interromper.wait(.1)
                            continue
                        sensor = sensores[api][contador % len(sensores[api])]
                        contador += 1
                        linha = medir_leitura(conexao, api, sensor, etapa["nome"], origem[0])
                        with lock:
                            http_writer.writerow(linha)
                            contadores[linha["resultado"]] += 1
                finally:
                    conexao.fechar()

            def coletar():
                iniciar.wait()
                while True:
                    inicio_consulta = time.perf_counter()
                    try:
                        linhas = consulta_k8s(args.contexto, args.namespace, apis)
                    except (RuntimeError, OSError) as erro:
                        linhas = [{"api": api, "erro": str(erro),
                                   **{k: "" for k in K8S_COLUNAS[2:-1]}} for api in apis]
                    instante = time.perf_counter() - origem[0]
                    with lock:
                        for linha in linhas:
                            k8s_writer.writerow({"tempo_s": instante, **linha})
                            contadores["lacunas"] += bool(linha["erro"])
                        arquivo_http.flush()
                        arquivo_k8s.flush()
                        print("t={:.1f}s | sucessos={} falhas={} lacunas_k8s={}".format(
                            instante, contadores["sucesso"], contadores["falha"],
                            contadores["lacunas"]), flush=True)
                    if terminar_coleta.is_set():
                        return
                    terminar_coleta.wait(max(0, intervalo - (time.perf_counter() - inicio_consulta)))

            maximo = max(e["concorrencia_por_api"] for e in etapas)
            with ThreadPoolExecutor(max_workers=len(apis) * maximo) as executor:
                futuros = [executor.submit(trabalhador, api, i)
                           for api in apis for i in range(maximo)]
                monitor = threading.Thread(target=coletar, name="coleta-kubernetes")
                monitor.start()
                metadata["status"] = "executando"
                metadata["inicio_carga_utc"] = agora()
                salvar_json(caminho_metadata, metadata)
                origem[0] = time.perf_counter()
                iniciar.set()
                try:
                    while not all(f.done() for f in futuros):
                        for futuro in futuros:
                            if futuro.done() and futuro.exception() is not None:
                                raise futuro.exception()
                        time.sleep(.05)
                    for futuro in futuros:
                        futuro.result()
                finally:
                    interrompido = interromper.is_set()
                    interromper.set()
                    terminar_coleta.set()
                    monitor.join()
                    metadata["observado_s"] = time.perf_counter() - origem[0]
            if interrompido:
                metadata["status"], codigo = "interrompido", 130
            elif contadores["falha"] or contadores["lacunas"]:
                metadata["status"], codigo = "com_falhas", 1
            else:
                metadata["status"], codigo = "concluido", 0
        except InterruptedError:
            metadata["status"], codigo = "interrompido", 130
        except (RuntimeError, OSError, ValueError, http.client.HTTPException) as erro:
            metadata["status"] = "falha_preparacao" if not origem[0] else "com_falhas"
            metadata["erro_execucao"] = str(erro)
            print("Falha:", erro, file=sys.stderr)
        finally:
            cliente.fechar()
            metadata["fim_utc"] = agora()
            salvar_json(caminho_metadata, metadata)
    meta, linhas_http, kubernetes = ler_resultados(pasta)
    resumo = salvar_resumo(pasta, meta, linhas_http, kubernetes)
    print("Resultados:", pasta, flush=True)
    for api, dados in resumo["apis"].items():
        print("{}: {} tentativas, {} sucessos, {} falhas".format(
            api, dados["total"], dados["sucessos"], dados["falhas"]), flush=True)
    return codigo, pasta


def argumentos(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api", choices=["todas"] + list(APIS), default="todas")
    parser.add_argument("--perfil", choices=["curto", "progressivo"], default="curto")
    parser.add_argument("--duracao", type=float, default=None, help="Segundos; somente perfil curto.")
    parser.add_argument("--concorrencia", type=int, default=None, help="Por API; somente perfil curto.")
    parser.add_argument("--base-url", default="http://localhost:30080")
    parser.add_argument("--contexto", default="docker-desktop")
    parser.add_argument("--namespace", default="aps")
    parser.add_argument("--timeout", type=float, default=10, help="Timeout de conexão/leitura, em segundos.")
    parser.add_argument("--saida", help="Pasta nova; nunca sobrescreve uma execução.")
    args = parser.parse_args(argv)
    if args.perfil == "progressivo" and (args.duracao is not None or args.concorrencia is not None):
        parser.error("--duracao e --concorrencia são ajustes do perfil curto.")
    args.duracao = 30 if args.duracao is None else args.duracao
    args.concorrencia = 2 if args.concorrencia is None else args.concorrencia
    if not math.isfinite(args.duracao) or not 0 < args.duracao <= 3600:
        parser.error("--duracao deve estar entre 0 e 3600 segundos.")
    if not 1 <= args.concorrencia <= 64:
        parser.error("--concorrencia deve estar entre 1 e 64 por API.")
    if not math.isfinite(args.timeout) or not 0 < args.timeout <= 60:
        parser.error("--timeout deve estar entre 0 e 60 segundos.")
    try:
        cliente = ClienteHTTP(args.base_url, args.timeout)
        cliente.fechar()
    except ValueError:
        parser.error("--base-url deve ser HTTP(S), sem credenciais, query ou fragmento.")
    return args


def main():
    args = argumentos()
    interromper = threading.Event()
    signal.signal(signal.SIGINT, lambda *_: interromper.set())
    signal.signal(signal.SIGTERM, lambda *_: interromper.set())
    try:
        codigo, _ = executar(args, interromper)
        return codigo
    except FileExistsError:
        print("A pasta de saída já existe; escolha outra para preservar os resultados.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
