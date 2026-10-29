import json
import os
from datetime import datetime, timezone
from urllib.error import HTTPError
from urllib.request import Request, urlopen


def consultar_sensores(base_url):
    with urlopen(f"{base_url}/get/sensores", timeout=10) as resposta:
        return json.load(resposta)


def enviar_json(url, dados):
    requisicao = Request(
        url,
        data=json.dumps(dados).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urlopen(requisicao, timeout=10) as resposta:
        return json.load(resposta)


def obter_sensor(base_url, nome, tipo):
    sensor = next((item for item in consultar_sensores(base_url) if item["nome"] == nome), None)
    if sensor is None:
        try:
            sensor = enviar_json(f"{base_url}/send/sensor", {"nome": nome, "tipo": tipo})
        except HTTPError as erro:
            if erro.code != 409:
                raise
            sensor = next(item for item in consultar_sensores(base_url) if item["nome"] == nome)
    if sensor["tipo"] != tipo:
        raise ValueError(f"O sensor {nome} ja esta cadastrado com outro tipo.")
    return sensor


def enviar_leitura():
    base_url = os.environ.get("API_URL", "http://localhost:3002").rstrip("/")
    sensores = [
        ("sensor-mp25", "MP25", {"mp25": 35.2}),
        ("sensor-co", "CO", {"co": 0.8}),
        ("sensor-no3", "NO3", {"no3": 12.4}),
        ("termometro", "TEMPERATURA", {"temperatura": 27.5}),
    ]
    for nome, tipo, medida in sensores:
        sensor = obter_sensor(base_url, nome, tipo)
        leitura = {"sensorId": sensor["id"], "estacao": "estacao-01", **medida}
        # Cada sensor gera o horario imediatamente antes de enviar sua medida.
        leitura["timestamp"] = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        print(json.dumps(enviar_json(f"{base_url}/send/qualidade-ar", leitura), ensure_ascii=False))


if __name__ == "__main__":
    enviar_leitura()
