# APS 2026 - APIs de Monitoramento Urbano

Monorepo com tres APIs independentes de monitoramento urbano. Cada API usa Node.js, Express, TypeScript, Prisma e PostgreSQL, com imagem Docker, Compose, rede, banco e volume proprios.

## APIs

| API | Diretorio | API | PostgreSQL | Banco | Volume |
|---|---|---:|---:|---|---|
| Alagamento e inundacao | `api-alagamento-inundacao/` | 3001 | 5433 | `alagamento` | `alagamento-db-data` |
| Qualidade do ar | `api-qualidade-do-ar/` | 3002 | 5434 | `qualidade_ar` | `qualidade-ar-db-data` |
| Transito e transporte | `api-transito-e-transporte/` | 3003 | 5435 | `transito` | `transito-db-data` |

## Arquitetura Docker

Cada diretorio de API possui uma pilha Compose independente com quatro servicos:

- `db`: PostgreSQL 16 com volume nomeado e healthcheck.
- `migrate`: aplica as migracoes Prisma depois que o banco fica saudavel.
- `api`: inicia somente depois das migracoes e possui healthcheck de readiness.
- `client`: cliente leve `curl` que acessa a API pela rede Docker.

Os servicos internos usam os nomes `db` e `api`; a conexao da aplicacao e feita por `db:5432`, nunca por `localhost`. As portas `localhost` existem apenas para testes a partir da maquina host.

Cada `Dockerfile` usa multi-stage build, gera o cliente Prisma em Linux, executa como o usuario nao-root `node` e mantem codigo TypeScript e ferramentas de build fora da imagem final.

## Subir as tres APIs

Cada API e iniciada individualmente no seu diretorio. Os valores padrao de porta permitem manter as tres pilhas ativas ao mesmo tempo.

```powershell
Set-Location api-alagamento-inundacao
Copy-Item .env.example .env
docker compose up --build -d

Set-Location ..\api-qualidade-do-ar
Copy-Item .env.example .env
docker compose up --build -d

Set-Location ..\api-transito-e-transporte
Copy-Item .env.example .env
docker compose up --build -d
```

Antes de subir cada pilha, altere `POSTGRES_PASSWORD` no respectivo `.env`. O arquivo `.env` e local e ignorado pelo Git.

### Variaveis de ambiente

Cada `.env.example` define:

```dotenv
POSTGRES_USER=postgres
POSTGRES_PASSWORD=change-me
POSTGRES_DB=nome_do_banco
DB_PORT=porta_do_postgres
API_PORT=porta_da_api
```

`DB_PORT` e `API_PORT` permitem trocar portas publicadas caso estejam ocupadas, sem alterar o Compose. A porta interna do banco permanece `5432`.

## Verificar a pilha

Execute os comandos no diretorio da API que deseja verificar:

```powershell
docker compose ps -a
docker compose logs migrate client
```

O resultado esperado e `db` e `api` saudaveis, com `migrate` e `client` finalizados em `Exited (0)`.

Healthchecks pela maquina host:

```powershell
Invoke-RestMethod "http://localhost:3001/health/live"
Invoke-RestMethod "http://localhost:3001/health/ready"

Invoke-RestMethod "http://localhost:3002/health/live"
Invoke-RestMethod "http://localhost:3002/health/ready"

Invoke-RestMethod "http://localhost:3003/health/live"
Invoke-RestMethod "http://localhost:3003/health/ready"
```

- `/health/live` confirma que a API esta em execucao.
- `/health/ready` confirma que a API tambem consegue consultar seu banco PostgreSQL.

## Cliente conteinerizado

O requisito 13 e atendido por um `client` leve em cada pilha Compose, nao por um cliente unico global.

- Pilha de alagamento: o `client` chama `http://api:3001/health/ready` e `http://api:3001/get/alagamento`.
- Pilha de qualidade do ar: o `client` chama `http://api:3002/health/ready` e `http://api:3002/get/qualidade-ar`.
- Pilha de transito: o `client` chama `http://api:3003/health/ready` e `http://api:3003/get/transito`.

Esses enderecos usam o DNS interno Docker (`api`) dentro de cada rede Compose, sem `localhost`, comprovando consumo pela pilha conteinerizada.

Para demonstrar:

```powershell
# No diretorio da API desejada
docker compose up --build -d
docker compose ps -a
docker compose logs client
```

Para reexecutar manualmente o cliente leve:

```powershell
Set-Location api-alagamento-inundacao
docker compose run --rm client

Set-Location ..\api-qualidade-do-ar
docker compose run --rm client

Set-Location ..\api-transito-e-transporte
docker compose run --rm client
```

## Endpoints e exemplos

Os exemplos abaixo usam `Invoke-RestMethod`, recomendado no PowerShell porque serializa JSON corretamente.

### Alagamento e inundacao

Base URL: `http://localhost:3001`

| Metodo | Rota | Descricao |
|---|---|---|
| GET | `/health/live` | Verifica se a API esta ativa. |
| GET | `/health/ready` | Verifica API e banco. |
| GET | `/get/alagamento` | Lista leituras persistidas. |
| POST | `/send/alagamento` | Cria uma leitura de nivel e chuva. |

```powershell
$body = @{
  sensor = "sensor-01"
  timestamp = "2026-09-21T12:00:00.000Z"
  nivelCorregoCm = 120.5
  chuvaAcumuladaMm = 35.2
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri "http://localhost:3001/send/alagamento" `
  -ContentType "application/json" `
  -Body $body

Invoke-RestMethod "http://localhost:3001/get/alagamento"
```

### Qualidade do ar

Base URL: `http://localhost:3002`

| Metodo | Rota | Descricao |
|---|---|---|
| GET | `/health/live` | Verifica se a API esta ativa. |
| GET | `/health/ready` | Verifica API e banco. |
| GET | `/get/qualidade-ar` | Lista leituras persistidas. |
| POST | `/send/qualidade-ar` | Cria uma leitura ambiental. |

```powershell
$body = @{
  estacao = "estacao-01"
  timestamp = "2026-09-21T12:00:00.000Z"
  mp25 = 35.2
  co = 0.8
  no3 = 12.4
  temperatura = 27.5
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri "http://localhost:3002/send/qualidade-ar" `
  -ContentType "application/json" `
  -Body $body

Invoke-RestMethod "http://localhost:3002/get/qualidade-ar"
```

### Transito e transporte

Base URL: `http://localhost:3003`

| Metodo | Rota | Descricao |
|---|---|---|
| GET | `/health/live` | Verifica se a API esta ativa. |
| GET | `/health/ready` | Verifica API e banco. |
| GET | `/get/transito` | Lista leituras persistidas. |
| POST | `/send/transito` | Cria uma leitura de veiculo. |

```powershell
$body = @{
  veiculo = "ABC-1234"
  timestamp = "2026-09-21T12:00:00.000Z"
  posicao = "-23.5505,-46.6333"
  velocidade = 42.5
  ocupacao = 0.75
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri "http://localhost:3003/send/transito" `
  -ContentType "application/json" `
  -Body $body

Invoke-RestMethod "http://localhost:3003/get/transito"
```

## Persistencia e operacao

Para parar uma pilha sem apagar os registros do banco:

```powershell
docker compose down
```

Para parar e apagar tambem o volume do banco daquela API:

```powershell
docker compose down -v
```

Para demonstrar persistencia, crie uma leitura, reinicie apenas o banco e consulte novamente a rota GET:

```powershell
docker compose restart db
Invoke-RestMethod "http://localhost:3001/get/alagamento"
```

## Evidencias da checklist

```powershell
# Imagens versionadas e usuario nao-root
docker images
docker image inspect aps-alagamento:1.0.0 --format '{{.Config.User}}'

# Servicos, healthchecks e cliente leve
docker compose ps -a
docker compose logs migrate client

# Configuracao renderizada, variaveis externas e URL interna db:5432
docker compose config
```

O comando de inspecao da imagem deve retornar `node`.

## Roteiro da checklist

1. Um Dockerfile por servico: confirme os tres Dockerfiles, um por API.
2. Multi-stage: confirme estagios `build`, `migrate`, `production-dependencies` e `runtime` nos Dockerfiles.
3. Imagem final enxuta: confirme que o runtime executa `dist/index.js` e nao depende do fonte TypeScript.
4. Usuario nao-root: `docker image inspect aps-alagamento:1.0.0 --format '{{.Config.User}}'` e equivalente para as outras APIs; resultado esperado `node`.
5. Imagens versionadas por tag: confirme `aps-alagamento:1.0.0`, `aps-qualidade-ar:1.0.0`, `aps-transito:1.0.0`.
6. `.dockerignore`: confirme existencia em cada API, excluindo `node_modules`, `generated`, `.env` e artefatos locais.
7. Compose sobe pilha completa: confirme servicos `db`, `migrate`, `api`, `client` em cada `docker-compose.yml`.
8. Comunicacao por nome de servico: confirme URLs internas com `db:5432` e `api:<porta>`.
9. Persistencia por volume: confirme volumes nomeados (`alagamento-db-data`, `qualidade-ar-db-data`, `transito-db-data`) e teste com `docker compose restart db`.
10. Configuracao por variaveis de ambiente: confirme uso de `.env` e placeholders em `docker-compose.yml`.
11. Sem credenciais no codigo-fonte: mantenha segredo real somente em `.env`; `POSTGRES_PASSWORD=change-me` fica apenas no `.env.example`.
12. Liveness e readiness distintos: valide `/health/live` e `/health/ready` nas tres APIs.
13. Cliente leve consumindo pela pilha: valide `docker compose run --rm client` nas tres APIs e confira chamadas internas para `http://api:<porta>`.
