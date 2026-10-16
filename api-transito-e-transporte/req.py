import json
import os
from datetime import datetime, timezone
from urllib.request import Request, urlopen


def enviar_leitura():
	leitura = {
		"posicao": "-23.5505,-46.6333",
		"velocidade": 42.5,
		"ocupacao": 0.75
	}
	leitura["timestamp"] = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
	base_url = os.environ.get("API_URL", "http://localhost:3003").rstrip("/")
	requisicao = Request(
		f"{base_url}/send/transito",
		data=json.dumps(leitura).encode("utf-8"),
		headers={"Content-Type": "application/json"},
		method="POST",
	)
	with urlopen(requisicao, timeout=10) as resposta:
		print(resposta.read().decode("utf-8"))


if __name__ == "__main__":
	enviar_leitura()
