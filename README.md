# APS 2026 — APIs de Monitoramento Urbano

Monorepo com 3 APIs independentes (Node.js + Express + TypeScript + Prisma + PostgreSQL), cada uma com seu próprio banco de dados, container Docker e porta.

| API | Pasta | Porta app | Porta DB | Banco |
|---|---|---|---|---|
| Alagamento e Inundação | `api-alagamento-inundacao/` | 3001 | 5433 | `alagamento` |
| Qualidade do Ar | `api-qualidade-do-ar/` | 3002 | 5434 | `qualidade_ar` |
| Trânsito e Transporte | `api-transito-e-transporte/` | 3003 | 5435 | `transito` |

## Como rodar cada API

Dentro da pasta da API desejada:

```powershell
npm install
docker compose up -d
npx prisma migrate dev
npm run dev
```

Cada API precisa de um arquivo `.env` próprio com a variável `DATABASE_URL` apontando para a porta do seu banco (veja a tabela acima). Exemplo:

```
DATABASE_URL="postgresql://postgres:postgres@localhost:5433/alagamento"
```

## api-alagamento-inundacao

Recebe leituras de sensores de nível de córrego e chuva.

**POST** `/send`

```json
{
  "sensor": "sensor-01",
  "timestamp": "2026-09-05T14:30:00.000Z",
  "nivelCorregoCm": 120.5,
  "chuvaAcumuladaMm": 35.2
}
```

## api-qualidade-do-ar

Recebe leituras de estações de qualidade do ar (MP2.5, CO, NO3 e temperatura).

**POST** `/send`

```json
{
  "estacao": "estacao-01",
  "timestamp": "2026-09-05T14:30:00.000Z",
  "mp25": 35.2,
  "co": 0.8,
  "no3": 12.4,
  "temperatura": 27.5
}
```

## api-transito-e-transporte

Recebe leituras de veículos (posição, velocidade e ocupação).

**POST** `/send`

```json
{
  "veiculo": "ABC-1234",
  "timestamp": "2026-09-05T14:30:00.000Z",
  "posicao": "-23.5505,-46.6333",
  "velocidade": 42.5,
  "ocupacao": 0.75
}
```
