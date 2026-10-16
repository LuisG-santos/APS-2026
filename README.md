# APS 2026 - Monitoramento Urbano

Tres APIs em Node.js, Express, TypeScript e Prisma conectadas ao mesmo banco PostgreSQL 16.

| API | Porta padrao | Consulta | Envio |
|---|---:|---|---|
| Alagamento e inundacao | 3001 | `/get/alagamento` | `/send/alagamento` |
| Qualidade do ar | 3002 | `/get/qualidade-ar` | `/send/qualidade-ar` |
| Transito e transporte | 3003 | `/get/transito` | `/send/transito` |

A API de transito tambem oferece `POST /send/sensor` para cadastrar equipamentos com nome e tipo, e `GET /get/sensores` para listar os sensores cadastrados.

## Executar com Docker

Na raiz do projeto:

```powershell
Copy-Item .env.example .env
# Edite POSTGRES_PASSWORD e os demais valores se necessario.
docker compose up --build -d
docker compose ps -a
```

O Compose inicia um banco `aps`, um servico `migrate`, as tres APIs e tres clientes de verificacao. Todas as APIs recebem a mesma `DATABASE_URL`, usando o endereco interno `db:5432`. Elas iniciam somente depois que as migrations forem concluidas.

O schema e todo o historico de migrations ficam em `prisma/`. O volume `aps-db-data` guarda as tabelas `Alagamento`, `QualidadeAr`, `SensorTransito` e `Transito`. Os Dockerfiles usam a raiz como contexto de build, executam em multiplos estagios e usam o usuario `node` no runtime.

As portas publicadas podem ser alteradas no `.env`: `DB_PORT`, `ALAGAMENTO_API_PORT`, `QUALIDADE_AR_API_PORT` e `TRANSITO_API_PORT`.

```powershell
docker compose logs migrate client-alagamento client-qualidade-ar client-transito
Invoke-RestMethod http://localhost:3001/health/ready
Invoke-RestMethod http://localhost:3002/health/ready
Invoke-RestMethod http://localhost:3003/health/ready
```

Cada API possui `/health/live` para verificar o processo e `/health/ready` para verificar a conexao com o banco.

## Timestamp das leituras

O sensor gera `timestamp` imediatamente antes de enviar a requisicao. Esse valor e obrigatorio no POST, fica salvo no banco e e retornado no GET. Use ISO 8601 com fuso, como `2026-10-09T00:30:00.123Z` ou `2026-10-08T21:30:00.123-03:00`. Horarios sem fuso e datas invalidas retornam HTTP 400.

`createdAt` registra o momento de gravacao no banco e e separado do `timestamp` do sensor.

## Enviar leituras

Os arquivos `req.py` simulam os sensores e geram o timestamp no momento de cada envio:

```powershell
python api-alagamento-inundacao/req.py
python api-qualidade-do-ar/req.py
python api-transito-e-transporte/req.py
```

O simulador de transito cadastra ou reutiliza os sensores `radar`, `gps` e `contador`. Cada equipamento envia uma requisicao independente com seu `sensorId`, timestamp e uma unica medida.

Defina `API_URL` para alterar o destino de um simulador, por exemplo `$env:API_URL = "http://localhost:3002"`.

Alagamento:

```json
{
    "sensor": "sensor-01",
    "timestamp": "2026-10-09T00:30:00.123Z",
    "nivelCorregoCm": 120.5,
    "chuvaAcumuladaMm": 35.2
}
```

Qualidade do ar exige `sensor` para identificar o equipamento e `estacao` para identificar o local:

```json
{
    "sensor": "sensor-ar-01",
    "estacao": "estacao-01",
    "timestamp": "2026-10-09T00:30:00.123Z",
    "mp25": 35.2,
    "co": 0.8,
    "no3": 12.4,
    "temperatura": 27.5
}
```

Transito: primeiro cadastre o sensor com `POST http://localhost:3003/send/sensor`:

```json
{
    "nome": "radar",
    "tipo": "RADAR"
}
```

Depois envie a leitura para `POST http://localhost:3003/send/transito`, usando o ID retornado no cadastro:

```json
{
    "sensorId": 1,
    "timestamp": "2026-10-09T00:30:00.123Z",
    "velocidade": 42.5
}
```

| Tipo do sensor | Medida aceita | Exemplo de nome |
|---|---|---|
| `RADAR` | `velocidade` | `radar` |
| `GPS` | `posicao` | `gps` |
| `OCUPACAO` | `ocupacao` | `contador` |

O sensor deve estar cadastrado, e cada leitura deve conter somente a medida correspondente ao seu tipo. A API rejeita nomes duplicados, sensores inexistentes e medidas misturadas. As respostas de transito incluem o sensor com seu nome e tipo; os campos das outras medidas ficam `null`. O campo `veiculo` continua removido.

Os exemplos completos e os comandos PowerShell estao em [sensores de transito](docs/sensores-transito.md).

## Desenvolvimento e testes

Use Node.js 22 ou superior. Para executar localmente fora dos containers, ajuste `DATABASE_URL` no `.env` e rode:

```powershell
npm ci
docker compose up -d db
npm run db:migrate
npm run build
```

Em tres terminais:

```powershell
npm run dev:alagamento
npm run dev:qualidade-ar
npm run dev:transito
```

Os testes usam um banco PostgreSQL separado e exigem `TEST_DATABASE_URL` com migrations aplicadas:

```powershell
docker compose exec db sh -c 'createdb -U "$POSTGRES_USER" aps_test'
$env:TEST_DATABASE_URL = "postgresql://postgres:change-me@localhost:5433/aps_test"
$env:DATABASE_URL = $env:TEST_DATABASE_URL
npm run db:migrate
npm test
Remove-Item Env:DATABASE_URL
Remove-Item Env:TEST_DATABASE_URL
```

A suite possui 25 testes de integracao: timestamp do sensor, datas invalidas, cadastro e identificacao dos equipamentos, nomes duplicados, sensores inexistentes, uma medida por sensor, banco compartilhado e rejeicao de corpos JSON com tipos incorretos.

## Tipagem das APIs

Cada API define seus contratos de entrada e resposta em `contracts.ts`. As rotas usam `Request` e `Response` parametrizados pelos tipos do projeto, com retorno explicito. O JSON recebido e tratado como `unknown` e validado antes que seus campos sejam usados. Dados enviados ao banco seguem os tipos gerados pelo Prisma.

As medidas de transito formam uma uniao de tipos mutuamente exclusivos: um corpo pode conter velocidade, posicao ou ocupacao. Misturar medidas ou informar um ID como texto produz erro de compilacao quando o contrato e usado em TypeScript e HTTP 400 quando um JSON invalido chega pela rede. O tipo do equipamento cadastrado tambem e conferido em tempo de execucao.

As respostas JSON representam `timestamp` e `createdAt` como strings ISO; os objetos Date usados pelo Prisma sao serializados explicitamente. Nenhuma conversao forcada e usada para transformar o corpo recebido em uma leitura.

Depois de instalar as dependencias e gerar o Prisma Client, verifique os contratos com:

```powershell
npm run typecheck
```

`tests/contracts.type-test.ts` verifica exemplos validos e rejeicoes esperadas pelo compilador, incluindo corpo nao validado, tipos incorretos e medidas misturadas. `npm test` executa build, verificacao de tipos e testes HTTP.

## Persistencia e volumes legados

`docker compose restart db` reinicia o banco sem perder leituras. `docker compose down` tambem preserva o volume; somente `docker compose down -v` remove `aps-db-data`.

As tres pilhas anteriores usavam volumes separados. Eles nao sao importados automaticamente para `aps-db-data` e foram preservados como backup durante esta migracao. O novo ambiente inicia com dados de desenvolvimento vazios, conforme decidido para este projeto.

Para quem ja usa o banco unico, a migration `20261016000000_sensores_transito` separa cada registro antigo de transito em tres leituras, mantendo medidas, timestamp e createdAt. O ID original permanece na velocidade; posicao e ocupacao recebem novos IDs. Os sensores antigos recebem nomes `legado:radar`, `legado:gps` e `legado:ocupacao`, indicando que a identificacao fisica nao era registrada. Em banco vazio, os cadastros sao feitos pelo novo POST.
