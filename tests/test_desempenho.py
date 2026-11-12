"""Testes do coletor: servidor local, sem PostgreSQL nem Kubernetes."""

import http.client
import json
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

            def responder(self, status, dados):
                corpo = json.dumps(dados).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(corpo)))
                self.end_headers()
                try:
                    self.wfile.write(corpo)
                except (BrokenPipeError, ConnectionResetError):
                    pass

            def do_GET(self):
                self.responder(200, {"status": "ready"})

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


if __name__ == "__main__":
    unittest.main()
