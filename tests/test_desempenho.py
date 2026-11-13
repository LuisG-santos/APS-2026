"""Testes do coletor: servidor local, sem PostgreSQL nem Kubernetes."""

import http.client
import json
import csv
import gzip
import random
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts/desempenho"))
import carga
import graficos


def snapshots(contexto, namespace, apis):
    return [{"api": api, "replicas_desejadas": 2, "replicas_atuais": 2,
             "replicas_prontas": 2, "cpu_percentual": 20, "erro": ""} for api in apis]


def leitura_valida(api, sensor, dados):
    resposta = {campo: None for _, campo, _ in carga.APIS[api]["medidas"]}
    resposta.update(dados)
    resposta.update(id=42, createdAt=carga.agora(), sensor=sensor)
    return resposta


class ServidorSimulado:
    def __init__(self, modo="normal"):
        self.modo = modo
        self.sensores = {api: {} for api in carga.APIS}
        self.recebidas = []
        self.lock = threading.Lock()
        estado = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def handle(self):
                try:
                    super().handle()
                except (ConnectionResetError, BrokenPipeError):
                    pass  # Esperado quando o cliente do teste atinge seu timeout.

            def log_message(self, *_):
                pass

            def responder(self, status, dados, atraso=0):
                corpo = json.dumps(dados).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(corpo)))
                if estado.modo != "sem-pod":
                    self.send_header("X-Pod", "pod-simulado-1")
                self.send_header("X-Versao", "teste")
                self.end_headers()
                self.wfile.flush()
                if atraso:
                    time.sleep(atraso)
                try:
                    self.wfile.write(corpo)
                except (BrokenPipeError, ConnectionResetError):
                    pass

            def do_GET(self):
                if "/get/sensores" in self.path:
                    api = self.path.split("/")[1]
                    with estado.lock:
                        dados = list(estado.sensores[api].values())
                    self.responder(200, dados)
                elif "/health/" in self.path:
                    self.responder(200, {"status": "ready"})
                else:
                    self.responder(404, {"error": "rota inexistente"})

            def do_POST(self):
                dados = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                api = self.path.split("/")[1]
                with estado.lock:
                    estado.recebidas.append((self.path, dados))
                    if self.path.endswith("/send/sensor"):
                        sensor = dict(dados, id=len(estado.sensores[api]) + 1,
                                      createdAt=carga.agora())
                        estado.sensores[api][sensor["id"]] = sensor
                    else:
                        sensor = estado.sensores[api][dados["sensorId"]]
                if self.path.endswith("/send/sensor"):
                    self.responder(201, sensor)
                elif estado.modo == "500":
                    self.responder(500, {"erro": "simulado"})
                elif estado.modo == "invalido":
                    self.responder(201, {"id": 1})
                elif estado.modo == "lento":
                    time.sleep(.2)
                    self.responder(201, leitura_valida(api, sensor, dados))
                elif estado.modo == "corpo-lento":
                    self.responder(201, leitura_valida(api, sensor, dados), atraso=.2)
                else:
                    self.responder(201, leitura_valida(api, sensor, dados))

        self.servidor = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.servidor.daemon_threads = True
        self.thread = threading.Thread(target=self.servidor.serve_forever)
        self.url = "http://127.0.0.1:" + str(self.servidor.server_port)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_):
        self.servidor.shutdown()
        self.servidor.server_close()
        self.thread.join()


class ContratosTest(unittest.TestCase):
    def test_dez_tipos_e_timestamp_com_fuso(self):
        quantidade = 0
        for api, config in carga.APIS.items():
            for tipo, campo, valor in config["medidas"]:
                sensor = {"id": 1, "tipo": tipo, "campo": campo, "valor": valor}
                dados = {"sensorId": 1, "timestamp": carga.agora(), campo: valor}
                self.assertEqual(carga.data_iso(dados["timestamp"]).utcoffset().total_seconds(), 0)
                resposta = leitura_valida(api, sensor, dados)
                # JSON.stringify de JavaScript devolve 8, mesmo que tenhamos enviado 8.0.
                if type(valor) is float and valor.is_integer():
                    resposta[campo] = int(valor)
                self.assertTrue(carga.validar_leitura(json.dumps(resposta), sensor, dados, api)[0])
                resposta["sensorId"] = 2
                self.assertFalse(carga.validar_leitura(json.dumps(resposta), sensor, dados, api)[0])
                quantidade += 1
        self.assertEqual(quantidade, 10)

    def test_resposta_invalida_e_campos_misturados(self):
        sensor = {"id": 1, "tipo": "NIVEL_CORREGO", "campo": "nivelCorregoCm", "valor": 120.5}
        dados = {"sensorId": 1, "timestamp": carga.agora(), "nivelCorregoCm": 120.5}
        for conteudo in (b"sem json", b"[]", b'{"id":1}', b"null"):
            self.assertFalse(carga.validar_leitura(conteudo, sensor, dados, "alagamento")[0])
        resposta = leitura_valida("alagamento", sensor, dados)
        resposta["chuvaAcumuladaMm"] = 10
        self.assertFalse(carga.validar_leitura(json.dumps(resposta), sensor, dados, "alagamento")[0])
        resposta["chuvaAcumuladaMm"] = None
        resposta["timestamp"] = "2026-11-11T10:00:00"
        self.assertFalse(carga.validar_leitura(json.dumps(resposta), sensor, dados, "alagamento")[0])

    def test_sem_retry_nos_erros_e_timeout(self):
        sensor = {"id": 1, "tipo": "GPS", "campo": "posicao", "valor": "-23,-46"}
        for excecao, codigo in [(socket.timeout(), "timeout"),
                                (ConnectionRefusedError(), "conexao"),
                                (http.client.RemoteDisconnected(), "conexao")]:
            cliente = Mock()
            cliente.enviar.side_effect = excecao
            linha = carga.medir_leitura(cliente, "transito", sensor, "curto", time.perf_counter())
            self.assertEqual(linha["erro"], codigo)
            self.assertEqual(linha["resultado"], "falha")
            self.assertGreaterEqual(linha["duracao_ms"], 0)
            self.assertEqual(cliente.enviar.call_count, 1)

    def test_perfis_limites_e_cooldown(self):
        etapas = carga.etapas_perfil("progressivo")
        self.assertEqual([e["concorrencia_por_api"] for e in etapas], [2, 8, 16, 0])
        self.assertEqual(sum(e["duracao_s"] for e in etapas), 540)
        self.assertEqual(carga.etapa_atual(etapas, 120)["concorrencia_por_api"], 8)
        self.assertEqual(carga.etapa_atual(etapas, 400)["nome"], "recuperacao")
        self.assertIsNone(carga.etapa_atual(etapas, 540))
        with self.assertRaises(SystemExit), patch("sys.stderr"):
            carga.argumentos(["--perfil", "progressivo", "--duracao", "1"])
        for args in (["--concorrencia", "0"], ["--duracao", "nan"], ["--timeout", "0"],
                     ["--base-url", "http://usuario:senha@localhost"]):
            with self.assertRaises(SystemExit), patch("sys.stderr"):
                carga.argumentos(args)


class AgregacaoTest(unittest.TestCase):
    def test_base_com_erros_http_nao_e_confundida_com_execucao_incompleta(self):
        meta={'run_id':'x','status':'com_falhas','observado_s':20,'config':{'apis':['alagamento'],'perfil':'base'},
              'etapas':[{'nome':'c1','duracao_s':20,'concorrencia_por_api':1,'aquecimento_s':5}]}
        linha=dict(self.linha(10,sucesso=False),inicio_s=9,etapa='c1',valida_para_degrau='1')
        r=graficos.calcular_resumo(meta,[linha],[])
        self.assertEqual(r['apis']['alagamento']['falhas'],1)
        self.assertTrue(r['degraus'][0]['completo'])
        self.assertFalse(any('incompleta/invalidada' in a for a in r['avisos']))
        self.assertTrue(any('concluída com falhas' in a for a in r['avisos']))

    def test_serie_relogio_utc_acompanha_ajuste_sem_alterar_duracoes(self):
        meta = {'inicio_carga_utc': '2026-11-13T10:00:00Z', 'config': {'apis': ['alagamento']},
                'etapas': [{'nome': 'curto', 'duracao_s': 3, 'concorrencia_por_api': 1}]}
        linhas = [dict(self.linha(.2), inicio_s=.1, inicio_utc='2026-11-13T10:00:00.100Z'),
                  dict(self.linha(1.2), inicio_s=1.1, inicio_utc='2026-11-13T10:00:07.100Z')]
        serie = graficos.serie_segundos(meta, linhas, 3)
        self.assertEqual(serie[0]['hora_utc'], '2026-11-13T10:00:00+00:00')
        self.assertEqual(serie[1]['hora_utc'], '2026-11-13T10:00:07+00:00')
        self.assertEqual(serie[1]['desvio_relogio_s'], 6)
        self.assertEqual(serie[2]['fonte_hora_utc'], 'estimada_sem_inicio_http')
        self.assertEqual([r['total'] for r in serie], [1,1,0])
        self.assertEqual(serie[1]['p95_ms'], 10)

    def test_publicacao_compactada_preserva_csv_e_releitura(self):
        with tempfile.TemporaryDirectory() as temp:
            origem, destino = Path(temp) / 'origem', Path(temp) / 'destino'
            origem.mkdir()
            (origem / 'execucao.json').write_text(json.dumps({'config': {'apis': ['alagamento']}}))
            bruto = 'api,status\nalagamento,201\nalagamento,500\n'
            (origem / 'http.csv').write_text(bruto)
            (origem / 'kubernetes.csv').write_text('api,erro\nalagamento,\n')
            graficos.publicar(origem, destino, limite_compressao=1)
            self.assertFalse((destino / 'http.csv').exists())
            with gzip.open(destino / 'http.csv.gz', 'rt') as f:
                self.assertEqual(f.read(), bruto)
            _, linhas, k8s = graficos.ler_resultados(destino)
            self.assertEqual([r['status'] for r in linhas], ['201', '500'])
            self.assertEqual(k8s[0]['api'], 'alagamento')

    def linha(self, fim, ms=10, sucesso=True):
        return {"api": "alagamento", "fim_s": fim, "duracao_ms": ms,
                "resultado": "sucesso" if sucesso else "falha",
                "erro": "" if sucesso else "timeout"}

    def test_percentis_conhecidos(self):
        valores = graficos.percentis(list(range(1, 101)))
        self.assertAlmostEqual(valores["p50_ms"], 50.5)
        self.assertAlmostEqual(valores["p95_ms"], 95.05)
        self.assertAlmostEqual(valores["p99_ms"], 99.01)

    def test_janelas_limites_rps_e_falhas(self):
        linhas = [self.linha(.1), self.linha(9), self.linha(10, sucesso=False), self.linha(12)]
        a, b = graficos.agregar(linhas, 15, 10)
        self.assertEqual(a["sucessos"], 2)
        self.assertEqual(a["sucessos_por_s"], .2)
        self.assertEqual(b["falhas_por_s"], .2)  # Última janela tem 5 segundos, não 10.
        self.assertEqual(b["erros_percentual"], 50)
        self.assertEqual(b["p99_ms"], 10)
        self.assertTrue(b["amostra_pequena"])

    def test_vazio_e_falhas_nao_viram_latencia_zero(self):
        a, b = graficos.agregar([self.linha(.1, 10000, False)], 20)
        self.assertIsNone(a["p95_ms"])
        self.assertEqual(a["erros_percentual"], 100)
        self.assertIsNone(b["p99_ms"])
        self.assertIsNone(b["erros_percentual"])
        self.assertEqual(b["sucessos_por_s"], 0)
        self.assertEqual(graficos.agregar([], 0), [])

    def test_resumo_recalcula_percentis_e_exclui_recuperacao_da_taxa(self):
        meta = {"run_id": "teste", "status": "concluido", "observado_s": 200,
                "config": {"apis": ["alagamento"]},
                "etapas": [{"duracao_s": 20, "concorrencia_por_api": 2},
                           {"duracao_s": 180, "concorrencia_por_api": 0}]}
        linhas = [self.linha(1, 1) for _ in range(99)] + [self.linha(11, 1000)]
        r = graficos.calcular_resumo(meta, linhas, [])["apis"]["alagamento"]
        self.assertEqual(r["p95_ms"], 1)
        self.assertEqual(r["conclusoes_por_s"], 5)
        self.assertNotEqual(r["p50_ms"], 500.5)


class KubernetesTest(unittest.TestCase):
    def test_parse_replicas_e_cpu(self):
        objetos = [
            {"kind": "Deployment", "metadata": {"name": "api-alagamento"},
             "spec": {"replicas": 3}, "status": {"replicas": 3, "readyReplicas": 2}},
            {"kind": "HorizontalPodAutoscaler", "metadata": {"name": "api-alagamento"},
             "status": {"currentMetrics": [
                 {"resource": {"name": "cpu", "current": {"averageUtilization": 72}}}]}},
        ]
        processo = subprocess.CompletedProcess([], 0, json.dumps({"items": objetos}), "")
        with patch.object(carga.subprocess, "run", return_value=processo) as chamada:
            r = carga.consultar_kubernetes("contexto", "aps", ["alagamento"])[0]
        self.assertEqual(r["replicas_desejadas"], 3)
        self.assertEqual(r["replicas_prontas"], 2)
        self.assertEqual(r["cpu_percentual"], 72)
        comando = chamada.call_args.args[0]
        self.assertIn("contexto", comando)
        self.assertNotIn("secret", comando)
        self.assertNotIn("apply", comando)

    def test_ausencia_e_falha_de_coleta(self):
        processo = subprocess.CompletedProcess([], 0, '{"items":[]}', "")
        with patch.object(carga.subprocess, "run", return_value=processo):
            linha = carga.consultar_kubernetes("c", "aps", ["alagamento"])[0]
        self.assertTrue(linha["erro"])
        self.assertEqual(linha["replicas_prontas"], "")
        with patch.object(carga.subprocess, "run", side_effect=subprocess.TimeoutExpired([], 5)):
            with self.assertRaises(RuntimeError):
                carga.consultar_kubernetes("c", "aps", ["alagamento"])


class IntegracaoLocalTest(unittest.TestCase):
    def executar(self, server, pasta, **kwargs):
        args = carga.argumentos(["--base-url", server.url, "--duracao", ".6",
                                 "--saida", str(pasta), *kwargs.pop("opcoes", [])])
        with patch("builtins.print"):
            kwargs.setdefault("consulta_recursos", lambda *_: [{"pod": "api-alagamento-teste", "container": "api",
                              "cpu_m": 100, "memoria_mib": 40, "erro": ""}])
            kwargs.setdefault("consulta_ambiente", lambda *_: {"quantidade_nos_observada": 1})
            return carga.executar(args, intervalo=.1, **kwargs)

    def test_tres_apis_sensores_isolados_csv_e_graficos(self):
        with tempfile.TemporaryDirectory() as temp, ServidorSimulado() as server:
            pasta = Path(temp) / "normal"
            codigo, _ = self.executar(server, pasta, consulta_k8s=snapshots)
            self.assertEqual(codigo, 0)
            meta, http, k8s = graficos.ler_resultados(pasta)
            self.assertEqual(meta["status"], "concluido")
            self.assertEqual(len([x for x in server.recebidas if x[0].endswith("/send/sensor")]), 10)
            for api in carga.APIS:
                self.assertEqual(len(meta["sensores"][api]), len(carga.APIS[api]["medidas"]))
                self.assertEqual({r["tipo_sensor"] for r in http if r["api"] == api},
                                 {m[0] for m in carga.APIS[api]["medidas"]})
                self.assertTrue(all(s["nome"].startswith("carga-" + meta["run_id"])
                                    for s in meta["sensores"][api]))
            self.assertTrue(all(r["resultado"] == "sucesso" for r in http))
            self.assertTrue(all(r["etapa"] == "curto" for r in http))
            self.assertTrue(k8s)
            resumo = graficos.gerar(pasta, janela=.2)
            self.assertEqual(sum(d["total"] for d in resumo["apis"].values()), len(http))
            for api in carga.APIS:
                self.assertTrue((pasta / (api + ".png")).read_bytes().startswith(b"\x89PNG"))
            self.assertTrue((pasta / "relatorio.pdf").read_bytes().startswith(b"%PDF"))
            self.assertTrue((pasta / "janelas.csv").exists())
            with self.assertRaises(FileExistsError):
                self.executar(server, pasta, consulta_k8s=snapshots)

    def test_500_e_resposta_invalida_ficam_no_csv(self):
        for modo, erro in [("500", "http_500"), ("invalido", "validacao")]:
            with self.subTest(modo=modo), tempfile.TemporaryDirectory() as temp, ServidorSimulado(modo) as server:
                pasta = Path(temp) / "falha"
                codigo, _ = self.executar(server, pasta, consulta_k8s=snapshots,
                                          opcoes=["--api", "alagamento", "--duracao", ".15"])
                self.assertEqual(codigo, 1)
                _, http, _ = graficos.ler_resultados(pasta)
                self.assertTrue(http)
                self.assertTrue(all(r["erro"] == erro for r in http))

    def test_timeout_real(self):
        with tempfile.TemporaryDirectory() as temp, ServidorSimulado("lento") as server:
            pasta = Path(temp) / "timeout"
            codigo, _ = self.executar(server, pasta, consulta_k8s=snapshots,
                                      opcoes=["--api", "transito", "--duracao", ".1", "--timeout", ".08"])
            self.assertEqual(codigo, 1)
            _, http, _ = graficos.ler_resultados(pasta)
            self.assertTrue(http)
            self.assertTrue(all(r["erro"] == "timeout" for r in http))

    def test_lacunas_preservadas_e_interrupcao(self):
        with tempfile.TemporaryDirectory() as temp, ServidorSimulado() as server:
            pasta = Path(temp) / "interrompido"
            stop = threading.Event()
            chamadas = [0]

            def coleta(contexto, namespace, apis):
                chamadas[0] += 1
                if chamadas[0] > 1:
                    stop.set()
                    raise RuntimeError("coleta indisponivel")
                return snapshots(contexto, namespace, apis)

            codigo, _ = self.executar(server, pasta, consulta_k8s=coleta, interromper=stop)
            self.assertEqual(codigo, 130)
            meta, _, k8s = graficos.ler_resultados(pasta)
            self.assertEqual(meta["status"], "interrompido")
            self.assertTrue(k8s)
            self.assertTrue(all(r["erro"] and r["replicas_prontas"] == "" for r in k8s))

    def test_preflight_falha_antes_de_cadastrar(self):
        with tempfile.TemporaryDirectory() as temp, ServidorSimulado() as server:
            pasta = Path(temp) / "sem-k8s"
            with patch("sys.stderr"):
                codigo, _ = self.executar(server, pasta,
                                          consulta_k8s=Mock(side_effect=RuntimeError("sem contexto")))
            self.assertEqual(codigo, 1)
            self.assertFalse(server.recebidas)
            meta, http, _ = graficos.ler_resultados(pasta)
            self.assertEqual(meta["status"], "falha_preparacao")
            self.assertFalse(http)

    def test_falha_de_coleta_nao_interrompe_http_e_deixa_lacuna(self):
        with tempfile.TemporaryDirectory() as temp, ServidorSimulado() as server:
            chamadas = [0]

            def coleta(contexto, namespace, apis):
                chamadas[0] += 1
                if chamadas[0] == 2:
                    raise RuntimeError("sem metricas")
                return snapshots(contexto, namespace, apis)

            pasta = Path(temp) / "coleta-parcial"
            codigo, _ = self.executar(server, pasta, consulta_k8s=coleta)
            self.assertEqual(codigo, 1)
            meta, http, k8s = graficos.ler_resultados(pasta)
            self.assertEqual(meta["status"], "com_falhas")
            self.assertTrue(all(r["resultado"] == "sucesso" for r in http))
            self.assertTrue(any(r["erro"] for r in k8s))
            self.assertTrue(any(not r["erro"] for r in k8s))

    def test_perfil_progressivo_para_envios_durante_recuperacao(self):
        etapas = [
            {"nome": "etapa-1", "duracao_s": .15, "concorrencia_por_api": 1},
            {"nome": "etapa-2", "duracao_s": .15, "concorrencia_por_api": 2},
            {"nome": "recuperacao", "duracao_s": .2, "concorrencia_por_api": 0},
        ]
        with tempfile.TemporaryDirectory() as temp, ServidorSimulado() as server:
            pasta = Path(temp) / "progressivo-acelerado"
            with patch.object(carga, "etapas_perfil", return_value=etapas):
                codigo, _ = self.executar(server, pasta, consulta_k8s=snapshots)
            self.assertEqual(codigo, 0)
            meta, http, k8s = graficos.ler_resultados(pasta)
            self.assertTrue(all(float(r["inicio_s"]) < .3 for r in http))
            self.assertEqual({r["etapa"] for r in http}, {"etapa-1", "etapa-2"})
            self.assertGreaterEqual(meta["observado_s"], .5)
            self.assertGreaterEqual(max(float(r["tempo_s"]) for r in k8s), .5)


class Etapa4Test(unittest.TestCase):
    executar = IntegracaoLocalTest.executar
    def test_degraus_base_tres_repeticoes_e_validacao_cli(self):
        a = carga.argumentos(["--perfil", "base"])
        etapas = carga.etapas_perfil(a.perfil, a.duracao, a.concorrencia,
                                    a.degraus, a.repeticoes, a.aquecimento)
        self.assertEqual(len(etapas), 21)
        self.assertEqual([e["concorrencia_por_api"] for e in etapas[:7]], [1, 2, 4, 8, 16, 32, 64])
        self.assertTrue(a.exigir_pod)
        self.assertEqual(etapas[0]["duracao_s"], 25)
        for opcoes in (["--perfil", "base", "-d", "5"], ["--degraus", "2,1"],
                       ["--degraus", "1,1"], ["--repeticoes", "0"], ["--estacoes", "0"],
                       ["--base-url", "https://example.com"], ["--metodo", "GET", "--rota", "/x"],
                       ["--perfil", "base", "-c", "2"]):
            with self.subTest(opcoes=opcoes), self.assertRaises(SystemExit), patch("sys.stderr"):
                carga.argumentos(opcoes)

    def test_valores_variados_mantem_dez_contratos(self):
        for api, config in carga.APIS.items():
            for tipo, campo, valor in config["medidas"]:
                sensor = {"id": 2, "tipo": tipo, "campo": campo, "valor": valor}
                rng = random.Random(4)
                amostras = [carga.dados_leitura(sensor, rng) for _ in range(20)]
                self.assertGreater(len({r[campo] for r in amostras}), 1)
                for dados in amostras:
                    self.assertEqual(set(dados), {"sensorId", "timestamp", campo})
                    self.assertTrue(carga.validar_leitura(json.dumps(leitura_valida(api, sensor, dados)),
                                                        sensor, dados, api)[0])
                    if campo == "ocupacao":
                        self.assertTrue(0 <= dados[campo] <= 1)

    def test_hpa_ausente_aceito_e_base_rejeita_hpa_ou_duas_replicas(self):
        deployment = {"kind": "Deployment", "metadata": {"name": "api-alagamento"},
                      "spec": {"replicas": 1}, "status": {"replicas": 1, "readyReplicas": 1}}
        with patch.object(carga.subprocess, "run", return_value=subprocess.CompletedProcess(
                [], 0, json.dumps({"items": [deployment]}), "")):
            linhas = carga.consultar_kubernetes("c", "aps", ["alagamento"])
        self.assertEqual(linhas[0]["erro"], "")
        carga.verificar_base(linhas)
        for alteracao in ({"hpa_presente": True}, {"replicas_prontas": 2}, {"erro": "sem dados"}):
            with self.assertRaises(RuntimeError):
                carga.verificar_base([{**linhas[0], **alteracao}])

    def test_recursos_cpu_memoria_e_falha(self):
        texto = "api-a api 500m 64Mi\nbanco-0 banco 1 1Gi\nx y 2000000n 1024Ki\n"
        with patch.object(carga.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, texto, "")):
            linhas = carga.consultar_recursos("c", "aps")
        self.assertEqual([r["cpu_m"] for r in linhas], [500, 1000, 2])
        self.assertEqual([r["memoria_mib"] for r in linhas], [64, 1024, 1])
        with patch.object(carga.subprocess, "run", return_value=subprocess.CompletedProcess([], 1, "", "")):
            with self.assertRaises(RuntimeError):
                carga.consultar_recursos("c", "aps")

    def test_cabecalhos_no_csv_e_get_sem_posts_de_leituras(self):
        with tempfile.TemporaryDirectory() as temp, ServidorSimulado() as server:
            pasta = Path(temp) / "get"
            codigo, _ = self.executar(server, pasta, consulta_k8s=snapshots,
                                      opcoes=["--api", "qualidade-ar", "--metodo", "GET", "--exigir-pod"])
            self.assertEqual(codigo, 0)
            meta, http, _ = graficos.ler_resultados(pasta)
            self.assertTrue(http)
            self.assertTrue(all(r["metodo"] == "GET" and r["status"] == "200" and
                                r["pod"] == "pod-simulado-1" and r["versao"] == "teste" for r in http))
            self.assertTrue(all(p.endswith("/send/sensor") for p, _ in server.recebidas))
            self.assertEqual(len({s["estacao"] for s in meta["sensores"]["qualidade-ar"]}), 3)
            resumo = json.loads((pasta / "resumo.json").read_text())["apis"]["qualidade-ar"]
            self.assertEqual(resumo["por_pod"], {"pod-simulado-1": len(http)})
            self.assertEqual(resumo["por_status"], {"200": len(http)})
            with (pasta / "serie-segundos.csv").open() as arquivo:
                serie = list(csv.DictReader(arquivo))
            self.assertEqual(sum(int(r["total"]) for r in serie), len(http))
            self.assertTrue(all(carga.data_iso(r["hora_utc"]) for r in serie))

    def test_falta_x_pod_explicitada_ou_bloqueada(self):
        with tempfile.TemporaryDirectory() as temp, ServidorSimulado("sem-pod") as server:
            pasta = Path(temp) / "sem-pod"
            codigo, _ = self.executar(server, pasta, consulta_k8s=snapshots,
                                      opcoes=["--api", "alagamento", "--exigir-pod"])
            self.assertEqual(codigo, 1)
            self.assertFalse(graficos.ler_resultados(pasta)[1])
            codigo, _ = self.executar(server, Path(temp) / "permitido", consulta_k8s=snapshots,
                                      opcoes=["--api", "alagamento"])
            self.assertEqual(codigo, 0)
            resumo = json.loads((Path(temp) / "permitido/resumo.json").read_text())
            self.assertGreater(resumo["apis"]["alagamento"]["sem_x_pod"], 0)
            self.assertTrue(any("X-Pod" in a for a in resumo["avisos"]))

    def test_base_completa_simulada_e_aquecimento_preservado(self):
        def base(c, n, apis):
            return [{"api": api, "replicas_desejadas": 1, "replicas_atuais": 1,
                     "replicas_prontas": 1, "cpu_percentual": "", "hpa_presente": False,
                     "erro": ""} for api in apis]
        with tempfile.TemporaryDirectory() as temp, ServidorSimulado() as server:
            pasta = Path(temp) / "base"
            codigo, _ = self.executar(server, pasta, consulta_k8s=base,
                                      opcoes=["--api", "alagamento", "--perfil", "base", "-d", ".4",
                                              "--aquecimento", ".1", "--degraus", "1,2"])
            self.assertEqual(codigo, 0)
            meta, http, _ = graficos.ler_resultados(pasta)
            self.assertEqual(len(meta["etapas"]), 6)
            self.assertTrue(any(r["aquecimento"] == "1" for r in http))
            r = json.loads((pasta / "resumo.json").read_text())
            self.assertEqual(len(r["degraus"]), 6)
            self.assertEqual({d["repeticao"] for d in r["degraus"]}, {1, 2, 3})
            self.assertTrue(all(d["completo"] and d["cpu_pod_max_m"] == 100 for d in r["degraus"]))
            self.assertEqual(r["apis"]["alagamento"]["total"], sum(x["valida_para_degrau"] == "1" for x in http))
            graficos.gerar(pasta)
            self.assertTrue((pasta / "alagamento-por-carga.png").exists())

    def test_base_invalidada_se_replicas_mudam(self):
        chamadas = [0]
        def coleta(c, n, apis):
            chamadas[0] += 1
            return [{"api": api, "replicas_desejadas": 1 if chamadas[0] < 3 else 2,
                     "replicas_atuais": 1, "replicas_prontas": 1, "hpa_presente": False,
                     "cpu_percentual": "", "erro": ""} for api in apis]
        with tempfile.TemporaryDirectory() as temp, ServidorSimulado() as server:
            pasta = Path(temp) / "mudou"
            codigo, _ = self.executar(server, pasta, consulta_k8s=coleta,
                                      opcoes=["--api", "alagamento", "--perfil", "base",
                                              "--aquecimento", ".1", "--degraus", "1"])
            self.assertEqual(codigo, 1)
            self.assertEqual(graficos.ler_resultados(pasta)[0]["status"], "base_invalidada")

    def test_aquecimento_fronteiras_saturacao_e_series_com_dados_conhecidos(self):
        meta = {"run_id": "x", "status": "concluido", "observado_s": 6,
                "inicio_carga_utc": "2026-11-13T10:00:00Z", "config": {"apis": ["alagamento"]},
                "etapas": [{"nome": "a", "duracao_s": 3, "concorrencia_por_api": 1, "aquecimento_s": 1},
                           {"nome": "b", "duracao_s": 3, "concorrencia_por_api": 2, "aquecimento_s": 1}]}
        def linha(inicio, fim, etapa):
            return {"api": "alagamento", "inicio_s": inicio, "fim_s": fim, "etapa": etapa,
                    "duracao_ms": (fim-inicio)*1000, "resultado": "sucesso", "status": 201,
                    "erro": "", "pod": "p"}
        linhas = [linha(.1,.2,"a"), linha(1,1.2,"a"), linha(2.9,3.1,"a"), linha(4,4.4,"b")]
        a, b = graficos.resumos_degraus(meta, linhas, [])
        self.assertEqual(a["total"], 1)
        self.assertAlmostEqual(a["p95_ms"], 200)
        self.assertEqual(a["sucessos_por_s"], .5)
        self.assertEqual(b["total"], 1)
        serie = graficos.serie_segundos(meta, linhas, 6)
        self.assertEqual([r["total"] for r in serie], [1,1,0,1,1,0])
        self.assertEqual(serie[4]["hora_utc"], "2026-11-13T10:00:04+00:00")
        self.assertIsNone(serie[2]["p95_ms"])
        candidato = graficos.detectar_saturacao([
            {**a, "total": 100, "sucessos_por_s": 50, "p95_ms": 10},
            {**b, "total": 100, "sucessos_por_s": 52, "p95_ms": 25}])
        self.assertEqual(candidato[0]["trabalhadores"], 2)
        self.assertFalse(candidato[0]["confirmado"])
        so_timeouts = graficos.detectar_saturacao([{**b, "total": 100, "falhas": 100, "p95_ms": None}])
        self.assertEqual(so_timeouts[0]["motivo"], "há erros")

    def test_contagens_por_pod_status_e_isolamento_por_api(self):
        linhas = [{"resultado": "sucesso", "duracao_ms": ms, "erro": "", "status": 201, "pod": pod}
                  for ms, pod in [(2, "a"), (4, "b"), (6, "b")]]
        linhas.append({"resultado": "falha", "duracao_ms": 10, "erro": "http_500", "status": 500, "pod": "a"})
        r = graficos.estatisticas(linhas, 2)
        self.assertEqual(r["por_pod"], {"a": 2, "b": 2})
        self.assertEqual(r["por_status"], {"201": 3, "500": 1})
        self.assertEqual(r["erros_percentual"], 25)
        self.assertEqual(r["sucessos_por_s"], 1.5)
        self.assertEqual(r["p50_ms"], 4)

    def test_recursos_ausentes_nao_inventam_cpu_e_publicacao_preserva_analise(self):
        with tempfile.TemporaryDirectory() as temp, ServidorSimulado() as server:
            pasta = Path(temp) / "recursos-ausentes"
            codigo, _ = self.executar(server, pasta, consulta_k8s=snapshots,
                                      consulta_recursos=Mock(side_effect=RuntimeError("sem métricas")),
                                      opcoes=["--api", "alagamento"])
            self.assertEqual(codigo, 1)
            with (pasta / "recursos.csv").open() as f:
                self.assertTrue(all(r["erro"] and r["cpu_m"] == "" for r in csv.DictReader(f)))
            resumo = json.loads((pasta / "resumo.json").read_text())
            self.assertIsNone(resumo["degraus"][0]["cpu_pod_max_m"])
            (pasta / "analise.md").write_text("Análise preenchida pelo grupo.")
            graficos.gerar(pasta)
            self.assertEqual((pasta / "analise.md").read_text(), "Análise preenchida pelo grupo.")
            (pasta / ".env").write_text("segredo simulado não pode ser publicado")
            destino = Path(temp) / "publicado"
            graficos.publicar(pasta, destino)
            self.assertTrue((destino / "alagamento-por-carga.png").exists())
            self.assertTrue((destino / "http.csv").exists())
            self.assertFalse((destino / ".env").exists())
            with self.assertRaises(FileExistsError):
                graficos.publicar(pasta, destino)

    def test_get_inexistente_bloqueia_preparacao(self):
        with tempfile.TemporaryDirectory() as temp, ServidorSimulado() as server:
            pasta = Path(temp) / "get-404"
            codigo, _ = self.executar(server, pasta, consulta_k8s=snapshots,
                                      opcoes=["--api", "alagamento", "--metodo", "GET", "--rota", "/alagamento/inexistente"])
            self.assertEqual(codigo, 1)
            meta, linhas, _ = graficos.ler_resultados(pasta)
            self.assertEqual(meta["status"], "falha_preparacao")
            self.assertFalse(linhas)

    def test_timeout_apos_cabecalho_preserva_status_e_pod_sem_retry(self):
        with tempfile.TemporaryDirectory() as temp, ServidorSimulado("corpo-lento") as server:
            pasta = Path(temp) / "timeout-corpo"
            codigo, _ = self.executar(server, pasta, consulta_k8s=snapshots,
                                      opcoes=["--api", "alagamento", "-d", ".1", "--timeout", ".08"])
            self.assertEqual(codigo, 1)
            _, linhas, _ = graficos.ler_resultados(pasta)
            self.assertTrue(linhas)
            self.assertTrue(all(r["erro"] == "timeout" and r["status"] == "201" and
                                r["pod"] == "pod-simulado-1" for r in linhas))
            self.assertEqual(len(linhas), len([p for p, _ in server.recebidas if not p.endswith("/send/sensor")]))


if __name__ == "__main__":
    unittest.main()
