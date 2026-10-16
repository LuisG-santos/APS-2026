import json
import os
from datetime import datetime, timezone
from urllib.request import Request, urlopen


def enviar_leitura():
	leitura = {
		"sensor": "sensor-ar-01",
		"estacao": "estacao-01",
		"mp25": 35.2,
		"co": 0.8,
		"no3": 12.4,
		"temperatura": 27.5
	}
	leitura["timestamp"] = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
	base_url = os.environ.get("API_URL", "http://localhost:3002").rstrip("/")
	requisicao = Request(
		f"{base_url}/send/qualidade-ar",
		data=json.dumps(leitura).encode("utf-8"),
		headers={"Content-Type": "application/json"},
		method="POST",
	)
	with urlopen(requisicao, timeout=10) as resposta:
		print(resposta.read().decode("utf-8"))


if __name__ == "__main__":
	enviar_leitura()
