"""Envia leituras concorrentes e registra HTTP e réplicas, sem alterar o cluster."""

import argparse
import csv
import http.client
import json
import math
import os
import platform
import random
import shlex
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

from graficos import ler_resultados, salvar_resumo, percentis


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
                "duracao_ms", "status", "resultado", "erro", "leitura_id",
                "metodo", "rota", "pod", "versao", "trabalhador", "concorrencia",
                "repeticao", "aquecimento", "valida_para_degrau"]
K8S_COLUNAS = ["tempo_s", "api", "replicas_desejadas", "replicas_atuais",
               "replicas_prontas", "cpu_percentual", "erro", "hpa_presente", "hora_utc",
               "cpu_limite", "memoria_limite"]
RECURSOS_COLUNAS = ["tempo_s", "hora_utc", "pod", "container", "cpu_m", "memoria_mib", "erro"]


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
        self.cabecalhos = {}
        self.status = ""

    def enviar(self, metodo, caminho, dados=None):
        self.cabecalhos = {}
        self.status = ""
        corpo = json.dumps(dados, allow_nan=False).encode("utf-8") if dados is not None else None
        try:
            self.conexao.request(metodo, self.prefixo + caminho, body=corpo,
                                  headers={"Content-Type": "application/json", "Accept": "application/json"})
            resposta = self.conexao.getresponse()
            self.status = resposta.status
            self.cabecalhos = {"pod": resposta.getheader("X-Pod", ""),
                               "versao": resposta.getheader("X-Versao", "")}
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


def dados_leitura(sensor, rng):
    valor = sensor["valor"]
    if sensor["campo"] == "posicao":
        valor = "{:.6f},{:.6f}".format(-23.55 + rng.uniform(-.01, .01),
                                      -46.63 + rng.uniform(-.01, .01))
    else:
        valor = round(valor * rng.uniform(.85, 1.05 if sensor["campo"] == "ocupacao" else 1.15), 3)
        if sensor["campo"] == "ocupacao":
            valor = min(valor, 1)
    return {"sensorId": sensor["id"], "timestamp": agora(), sensor["campo"]: valor}


def medir_leitura(cliente, api, sensor, etapa, origem, metodo="POST", rota=None, rng=None):
    dados = dados_leitura(sensor, rng or random.Random()) if metodo == "POST" else None
    rota = rota or "/" + api + ("/send/" + api if metodo == "POST" else "/get/sensores")
    inicio_utc = agora()
    inicio = time.perf_counter()
    status, conteudo, erro = "", b"", ""
    try:
        status, conteudo = cliente.enviar(metodo, rota, dados)
    except (socket.timeout, TimeoutError):
        erro = "timeout"
    except (OSError, http.client.HTTPException):
        erro = "conexao"
    fim = time.perf_counter()  # Inclui conexão/envio/leitura; não inclui CSV nem validação JSON.
    if erro and type(getattr(cliente, "status", None)) is int:
        status = cliente.status  # Preserva cabeçalhos recebidos mesmo se o corpo falhar.
    valido, leitura_id = False, ""
    if not erro:
        if status != (201 if metodo == "POST" else 200):
            erro = "http_" + str(status)
        else:
            if metodo == "POST":
                valido, leitura_id = validar_leitura(conteudo, sensor, dados, api)
            else:
                try:
                    resposta = json.loads(conteudo)
                    valido = isinstance(resposta, (list, dict))
                    if rota == "/" + api + "/get/sensores":
                        valido = isinstance(resposta, list) and all(
                            isinstance(s, dict) and id_valido(s.get("id")) and
                            isinstance(s.get("nome"), str) and
                            s.get("tipo") in {m[0] for m in APIS[api]["medidas"]}
                            for s in resposta)
                except (ValueError, UnicodeError):
                    valido = False
            if not valido:
                erro = "validacao"
    return {
        "api": api, "tipo_sensor": sensor["tipo"] if metodo == "POST" else "CONSULTA", "etapa": etapa,
        "inicio_utc": inicio_utc, "inicio_s": inicio - origem, "fim_s": fim - origem,
        "duracao_ms": (fim - inicio) * 1000, "status": status,
        "resultado": "sucesso" if valido else "falha", "erro": erro, "leitura_id": leitura_id,
        "metodo": metodo, "rota": rota,
        "pod": cliente.cabecalhos.get("pod", ""), "versao": cliente.cabecalhos.get("versao", ""),
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
            hpa = next((obj for obj in objetos if obj["kind"] == "HorizontalPodAutoscaler" and
                        (obj.get("spec", {}).get("scaleTargetRef", {}).get("name") == nome or
                         obj["metadata"]["name"] == nome)), None)
            if deployment is None:
                linhas.append({"api": api, "erro": "Deployment ausente",
                               **{k: "" for k in K8S_COLUNAS[2:] if k != "erro"}})
                continue
            status = deployment.get("status", {})
            containers = deployment.get("spec", {}).get("template", {}).get("spec", {}).get("containers", [])
            limites = containers[0].get("resources", {}).get("limits", {}) if containers else {}
            cpu = next((
                m.get("resource", {}).get("current", {}).get("averageUtilization", "")
                for m in (hpa or {}).get("status", {}).get("currentMetrics", [])
                if m.get("resource", {}).get("name") == "cpu"), "")
            linhas.append({
                "api": api, "replicas_desejadas": deployment["spec"].get("replicas", 1),
                "replicas_atuais": status.get("replicas", 0),
                "replicas_prontas": status.get("readyReplicas", 0),
                "cpu_percentual": cpu, "erro": "", "hpa_presente": hpa is not None,
                "cpu_limite": limites.get("cpu", ""), "memoria_limite": limites.get("memory", ""),
            })
        return linhas
    except (ValueError, KeyError, TypeError):
        raise RuntimeError("Resposta Kubernetes inválida.") from None


def preparar_sensores(cliente, apis, run_id, interromper, registrar, estacoes=3):
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
                dados["estacao"] = "carga-" + run_id + "-estacao-" + str(len(sensores[api]) % estacoes + 1)
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


def etapas_perfil(perfil, duracao=30, concorrencia=2, degraus=None, repeticoes=3, aquecimento=5):
    if perfil == "curto":
        return [{"nome": "curto", "duracao_s": duracao, "concorrencia_por_api": concorrencia}]
    if perfil == "base":
        return [{"nome": "r{}-c{}".format(r, n), "duracao_s": duracao,
                 "concorrencia_por_api": n, "repeticao": r, "aquecimento_s": aquecimento}
                for r in range(1, repeticoes + 1) for n in (degraus or [1, 2, 4, 8, 16, 32, 64])]
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


def inicio_etapa(etapas, etapa):
    return sum(e["duracao_s"] for e in etapas[:etapas.index(etapa)])


def consultar_recursos(contexto, namespace):
    comando = ["kubectl", "--context", contexto, "--request-timeout=3s", "top", "pods",
               "-n", namespace, "--containers", "--no-headers"]
    resposta = subprocess.run(comando, capture_output=True, text=True, timeout=5)
    if resposta.returncode:
        raise RuntimeError("kubectl top indisponível; sem dados de CPU/memória.")
    linhas = []
    for linha in resposta.stdout.splitlines():
        pod, container, cpu, memoria = linha.split()
        def quantidade(texto, unidades):
            for unidade, fator in unidades:
                if unidade and texto.endswith(unidade):
                    return float(texto[:-len(unidade)]) * fator
            return float(texto)
        cpu_m = quantidade(cpu, [("m", 1), ("n", .000001), ("u", .001)])
        if not cpu.endswith(("m", "n", "u")):
            cpu_m *= 1000
        mib = quantidade(memoria, [("Ki", 1/1024), ("Mi", 1), ("Gi", 1024),
                                   ("Ti", 1024**2), ("K", 1000/1024**2),
                                   ("M", 1000**2/1024**2), ("G", 1000**3/1024**2)])
        if not memoria.endswith(("Ki", "Mi", "Gi", "Ti", "K", "M", "G")):
            mib /= 1024**2
        if not math.isfinite(cpu_m) or not math.isfinite(mib) or cpu_m < 0 or mib < 0:
            raise ValueError("Métrica de recurso inválida.")
        linhas.append({"pod": pod, "container": container, "cpu_m": cpu_m,
                       "memoria_mib": mib, "erro": ""})
    return linhas or [{"pod": "", "container": "", "cpu_m": "", "memoria_mib": "",
                       "erro": "kubectl top sem amostras"}]


def verificar_base(linhas, apis_esperadas=None):
    if (apis_esperadas is not None and {r.get("api") for r in linhas} != set(apis_esperadas)) or any(r.get("hpa_presente") is not False or
           any(r.get(k) != 1 for k in ("replicas_desejadas", "replicas_atuais", "replicas_prontas"))
           or r.get("erro") for r in linhas):
        raise RuntimeError("Linha de base exige 1 réplica desejada/atual/pronta por API e HPA ausente.")


def consultar_ambiente(contexto, namespace):
    resposta = subprocess.run(["kubectl", "--context", contexto, "--request-timeout=3s",
                               "get", "nodes", "-o", "json"],
                              capture_output=True, text=True, timeout=5)
    if resposta.returncode:
        raise RuntimeError("Não foi possível consultar capacidade dos nós.")
    nodes = json.loads(resposta.stdout)["items"]
    return {"quantidade_nos_observada": len(nodes), "nos": [
        {"nome": n["metadata"]["name"], "capacidade": n.get("status", {}).get("capacity", {}),
         "alocavel": n.get("status", {}).get("allocatable", {})} for n in nodes]}


def salvar_json(caminho, dados):
    temporario = caminho.with_suffix(".tmp")
    temporario.write_text(json.dumps(dados, indent=2, ensure_ascii=False, allow_nan=False),
                          encoding="utf-8")
    temporario.replace(caminho)


def executar(args, interromper=None, consulta_k8s=consultar_kubernetes, intervalo=5,
             consulta_recursos=consultar_recursos, consulta_ambiente=consultar_ambiente):
    interromper = interromper if interromper is not None else threading.Event()
    apis = list(APIS) if args.api == "todas" else [args.api]
    etapas = etapas_perfil(args.perfil, args.duracao, args.concorrencia,
                          args.degraus, args.repeticoes, args.aquecimento)
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8]
    pasta = Path(args.saida) if args.saida else Path("evidencias/desempenho") / run_id
    pasta.mkdir(parents=True, exist_ok=False)
    metadata = {
        "versao": 2, "run_id": run_id, "status": "preparando", "inicio_utc": agora(),
        "observado_s": 0, "etapas": etapas, "sensores": {},
        "comando": shlex.join([sys.executable, "scripts/desempenho/carga.py"] + args.argumentos),
        "ambiente": {"python": platform.python_version(), "sistema": platform.platform(),
                     "cpu_gerador": platform.processor(), "nucleos_logicos_gerador": os.cpu_count(),
                     "cpu_cluster": args.cpu_cluster, "ram_cluster_gb": args.ram_cluster_gb,
                     "nos_cluster": args.nos, "gerador_mesma_maquina": not args.gerador_fora_cluster,
                     "observacoes": args.observacoes},
        "config": {"apis": apis, "base_url": args.base_url, "perfil": args.perfil,
                   "contexto": args.contexto, "namespace": args.namespace,
                   "timeout_s": args.timeout, "intervalo_k8s_s": intervalo,
                   "metodo": args.metodo, "rota": args.rota, "semente": args.semente,
                   "exigir_pod": args.exigir_pod,
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
    recentes = []
    desvios_base = []
    codigo = 1
    with (pasta / "http.csv").open("w", newline="", encoding="utf-8") as arquivo_http, \
            (pasta / "kubernetes.csv").open("w", newline="", encoding="utf-8") as arquivo_k8s, \
            (pasta / "recursos.csv").open("w", newline="", encoding="utf-8") as arquivo_recursos:
        http_writer = csv.DictWriter(arquivo_http, fieldnames=HTTP_COLUNAS)
        k8s_writer = csv.DictWriter(arquivo_k8s, fieldnames=K8S_COLUNAS)
        http_writer.writeheader()
        k8s_writer.writeheader()
        recursos_writer = csv.DictWriter(arquivo_recursos, fieldnames=RECURSOS_COLUNAS)
        recursos_writer.writeheader()
        try:
            inicial = consulta_k8s(args.contexto, args.namespace, apis)
            if (len(inicial) != len(apis) or
                    any(r["erro"] or r["replicas_prontas"] < 1 for r in inicial)):
                raise RuntimeError("APIs ausentes ou sem réplicas prontas no contexto informado.")
            if args.perfil == "base":
                base_cluster = consulta_k8s(args.contexto, args.namespace, list(APIS))
                if len(base_cluster) != len(APIS):
                    raise RuntimeError("Linha de base exige consultar as três APIs.")
                verificar_base(base_cluster, APIS)
                metadata["base_cluster_inicial"] = base_cluster
            metadata["kubernetes_inicial"] = inicial
            try:
                metadata["ambiente"]["cluster"] = consulta_ambiente(args.contexto, args.namespace)
            except (RuntimeError, OSError, ValueError, KeyError, subprocess.TimeoutExpired):
                metadata["ambiente"]["erro_coleta_cluster"] = "Capacidade dos nós indisponível; preencher dados do ambiente manualmente."

            def registrar(sensores):
                metadata["sensores"] = sensores
                salvar_json(caminho_metadata, metadata)

            sensores = preparar_sensores(cliente, apis, run_id, interromper, registrar, args.estacoes)

            # Verifica a rota GET antes do cronômetro. Não mede cadastros nem readiness.
            if args.metodo == "GET":
                for api in apis:
                    teste = medir_leitura(cliente, api, sensores[api][0], "preparacao",
                                          time.perf_counter(), "GET", args.rota)
                    if teste["erro"]:
                        raise RuntimeError("Rota de consulta inválida: " + api + "/" + teste["erro"])
            if args.exigir_pod:
                for api in apis:
                    cliente.enviar("GET", "/" + api + "/health/live")
                    if not cliente.cabecalhos.get("pod"):
                        raise RuntimeError("API " + api + " não retorna X-Pod; atualize sua imagem.")

            def trabalhador(api, indice):
                conexao = ClienteHTTP(args.base_url, args.timeout)
                contador = indice
                rng = random.Random(args.semente + list(APIS).index(api) * 1000 + indice)
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
                        linha = medir_leitura(conexao, api, sensor, etapa["nome"], origem[0],
                                              args.metodo, args.rota, rng)
                        inicio = inicio_etapa(etapas, etapa)
                        limite = inicio + etapa["duracao_s"]
                        aquecimento = float(linha["inicio_s"]) < inicio + etapa.get("aquecimento_s", 0)
                        linha.update(trabalhador=indice, concorrencia=etapa["concorrencia_por_api"],
                                     repeticao=etapa.get("repeticao", 1), aquecimento=int(aquecimento),
                                     valida_para_degrau=int(not aquecimento and float(linha["fim_s"]) <= limite))
                        with lock:
                            http_writer.writerow(linha)
                            contadores[linha["resultado"]] += 1
                            recentes.append(linha)
                finally:
                    conexao.fechar()

            def coletar():
                iniciar.wait()
                while True:
                    inicio_consulta = time.perf_counter()
                    try:
                        linhas = consulta_k8s(args.contexto, args.namespace,
                                              list(APIS) if args.perfil == "base" else apis)
                    except (RuntimeError, OSError) as erro:
                        linhas = [{"api": api, "erro": str(erro),
                                   **{k: "" for k in K8S_COLUNAS[2:] if k != "erro"}} for api in apis]
                    instante = time.perf_counter() - origem[0]
                    if args.perfil == "base":
                        try:
                            verificar_base(linhas, APIS)
                        except RuntimeError as erro:
                            desvios_base.append({"tempo_s": instante, "erro": str(erro)})
                            # Interrompe a base se HPA ou réplicas mudarem, sem alterar recursos.
                            interromper.set()
                    try:
                        recursos = consulta_recursos(args.contexto, args.namespace)
                    except (RuntimeError, OSError, ValueError, subprocess.TimeoutExpired) as erro:
                        recursos = [{"pod": "", "container": "", "cpu_m": "", "memoria_mib": "",
                                     "erro": type(erro).__name__ + ": coleta de recursos indisponível"}]
                    with lock:
                        for linha in linhas:
                            k8s_writer.writerow({**linha, "tempo_s": instante, "hora_utc": agora()})
                            contadores["lacunas"] += bool(linha["erro"])
                        for recurso in recursos:
                            recursos_writer.writerow({**recurso, "tempo_s": time.perf_counter() - origem[0],
                                                      "hora_utc": agora()})
                            contadores["lacunas"] += bool(recurso["erro"])
                        arquivo_http.flush()
                        arquivo_k8s.flush()
                        arquivo_recursos.flush()
                    if terminar_coleta.is_set():
                        return
                    terminar_coleta.wait(max(0, intervalo - (time.perf_counter() - inicio_consulta)))

            def progresso():
                iniciar.wait()
                ultimo = 0.0
                while True:
                    fim = terminar_coleta.wait(1)
                    instante = time.perf_counter() - origem[0]
                    with lock:
                        linhas = recentes[:]
                        recentes.clear()
                    etapa = etapa_atual(etapas, instante)
                    ativos = etapa["concorrencia_por_api"] * len(apis) if etapa else 0
                    ok = [float(r["duracao_ms"]) for r in linhas if r["resultado"] == "sucesso"]
                    p = percentis(ok)
                    print("{} | trabalhadores={} OK/s={:.1f} erros={} p50={}ms p95={}ms pods={}".format(
                        agora(), ativos, len(ok) / max(instante - ultimo, .001), len(linhas)-len(ok),
                        round(p["p50_ms"], 2) if ok else "-", round(p["p95_ms"], 2) if ok else "-",
                        len({r["pod"] for r in linhas if r["pod"]})), flush=True)
                    ultimo = instante
                    if fim:
                        return

            maximo = max(e["concorrencia_por_api"] for e in etapas)
            with ThreadPoolExecutor(max_workers=len(apis) * maximo) as executor:
                futuros = [executor.submit(trabalhador, api, i)
                           for api in apis for i in range(maximo)]
                monitor = threading.Thread(target=coletar, name="coleta-kubernetes")
                monitor.start()
                monitor_progresso = threading.Thread(target=progresso, name="progresso-carga")
                monitor_progresso.start()
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
                    metadata["fim_http_s"] = time.perf_counter() - origem[0]
                    interromper.set()
                    terminar_coleta.set()
                    monitor.join()
                    monitor_progresso.join()
                    metadata["observado_s"] = time.perf_counter() - origem[0]
            if desvios_base:
                metadata["status"], codigo = "base_invalidada", 1
                metadata["desvios_base"] = desvios_base
            elif interrompido:
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
        print("{}: {} tentativas, {} sucessos, {} falhas | {:.1f} OK/s | p50={} p95={} p99={} ms | pods={}".format(
            api, dados["total"], dados["sucessos"], dados["falhas"], dados["sucessos_por_s"] or 0,
            dados["p50_ms"], dados["p95_ms"], dados["p99_ms"], dados["por_pod"]), flush=True)
    for aviso in resumo["avisos"]:
        print("Aviso:", aviso, flush=True)
    return codigo, pasta


def argumentos(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api", choices=["todas"] + list(APIS), default="todas")
    parser.add_argument("--perfil", choices=["curto", "progressivo", "base"], default="curto")
    parser.add_argument("--duracao", "-d", type=float, default=None, help="Segundos por degrau; base: 25; curto: 30.")
    parser.add_argument("--concorrencia", "-c", type=int, default=None, help="Por API; somente perfil curto.")
    parser.add_argument("--degraus", default="1,2,4,8,16,32,64", help="Concorrências da base, separadas por vírgula.")
    parser.add_argument("--aquecimento", type=float, default=5, help="Segundos descartados por degrau da base.")
    parser.add_argument("--repeticoes", type=int, default=3, help="Repetições da sequência da base.")
    parser.add_argument("--metodo", choices=["POST", "GET"], default="POST")
    parser.add_argument("--rota", help="Caminho GET pelo Ingress, incluindo /<api>; requer uma API selecionada.")
    parser.add_argument("--exigir-pod", action="store_true", help="Falha na preparação se X-Pod estiver ausente.")
    parser.add_argument("--estacoes", type=int, default=3, help="Estações de qualidade do ar entre 1 e 4.")
    parser.add_argument("--semente", type=int, default=2026, help="Semente dos valores simulados por trabalhador.")
    parser.add_argument("--cpu-cluster", help="Modelo/CPU alocada à máquina do cluster, para o relatório.")
    parser.add_argument("--ram-cluster-gb", type=float, help="RAM alocada à máquina do cluster.")
    parser.add_argument("--nos", type=int, help="Quantidade de nós do cluster.")
    parser.add_argument("--gerador-fora-cluster", action="store_true", help="Gerador em outra máquina física.")
    parser.add_argument("--observacoes", default="", help="Limites da VM, CPU/memória do gerador e demais condições.")
    parser.add_argument("--base-url", default="http://localhost:30080")
    parser.add_argument("--contexto", default="docker-desktop")
    parser.add_argument("--namespace", default="aps")
    parser.add_argument("--timeout", type=float, default=10, help="Timeout de conexão/leitura, em segundos.")
    parser.add_argument("--saida", help="Pasta nova; nunca sobrescreve uma execução.")
    args = parser.parse_args(argv)
    args.argumentos = list(sys.argv[1:] if argv is None else argv)
    if args.perfil == "progressivo" and (args.duracao is not None or args.concorrencia is not None):
        parser.error("--duracao e --concorrencia são ajustes do perfil curto.")
    if args.perfil == "base" and args.concorrencia is not None:
        parser.error("Use --degraus para ajustar a concorrência da base.")
    args.duracao = (25 if args.perfil == "base" else 30) if args.duracao is None else args.duracao
    args.concorrencia = 2 if args.concorrencia is None else args.concorrencia
    if args.perfil != "base":
        args.aquecimento = 0
    else:
        args.exigir_pod = True
    if not math.isfinite(args.duracao) or not 0 < args.duracao <= 3600:
        parser.error("--duracao deve estar entre 0 e 3600 segundos.")
    if not 1 <= args.concorrencia <= 64:
        parser.error("--concorrencia deve estar entre 1 e 64 por API.")
    if not math.isfinite(args.timeout) or not 0 < args.timeout <= 60:
        parser.error("--timeout deve estar entre 0 e 60 segundos.")
    try:
        args.degraus = [int(x) for x in args.degraus.split(",")]
        if (not args.degraus or args.degraus != sorted(set(args.degraus)) or
                any(n < 1 or n > 64 for n in args.degraus)):
            raise ValueError()
    except ValueError:
        parser.error("--degraus exige inteiros crescentes, sem repetição, entre 1 e 64.")
    if not math.isfinite(args.aquecimento) or not 0 <= args.aquecimento < args.duracao:
        parser.error("--aquecimento deve ser finito, não negativo e menor que --duracao.")
    if not 1 <= args.repeticoes <= 10 or not 1 <= args.estacoes <= 4:
        parser.error("Use 1 a 10 repetições e 1 a 4 estações.")
    if args.ram_cluster_gb is not None and (not math.isfinite(args.ram_cluster_gb) or args.ram_cluster_gb <= 0):
        parser.error("--ram-cluster-gb deve ser positivo e finito.")
    if args.nos is not None and args.nos < 1:
        parser.error("--nos deve ser positivo.")
    if args.rota and (args.metodo != "GET" or args.api == "todas" or
                      not args.rota.startswith("/" + args.api + "/") or
                      any(c in args.rota for c in ("\r", "\n", "#"))):
        parser.error("--rota exige GET, uma API e caminho começando por /<api>/.")
    try:
        cliente = ClienteHTTP(args.base_url, args.timeout)
        cliente.fechar()
        if urlsplit(args.base_url).hostname not in ("localhost", "127.0.0.1", "::1"):
            parser.error("A carga desta APS é restrita ao cluster do grupo em localhost; use port-forward.")
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
