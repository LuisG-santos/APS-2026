# APS 2026 - Monitoramento Urbano

Tres APIs em Node.js, Express, TypeScript e Prisma conectadas ao mesmo banco PostgreSQL 16.

| API | Porta padrao | Consulta | Envio |
|---|---:|---|---|
| Alagamento e inundacao | 3001 | `/get/alagamento` | `/send/alagamento` |
| Qualidade do ar | 3002 | `/get/qualidade-ar` | `/send/qualidade-ar` |
| Transito e transporte | 3003 | `/get/transito` | `/send/transito` |

As tres APIs oferecem `POST /send/sensor` para cadastrar equipamentos com nome e tipo, e `GET /get/sensores` para listar os sensores cadastrados. Cada leitura recebe o `sensorId` do equipamento e uma unica medida compativel com seu tipo.

## Etapa 3 - Kubernetes

A pasta `k8s/` acrescenta a implantacao no Docker Desktop: um Deployment e um Service por API, Ingress com Traefik, banco unico em StatefulSet com volume persistente, ConfigMap, Secrets locais, Job de migrations e HPA por CPU nas tres APIs, com metrics-server, cache Redis compartilhado, RabbitMQ persistente e worker de alertas. Os contratos de cadastro e ingestao das APIs continuam os mesmos.

Depois de habilitar o cluster, construir as imagens, gerar o Secret do banco e executar `node scripts/k8s/gerar-secret-fila.mjs`, aplique tudo com `kubectl apply -f k8s/`. O [guia da etapa 3](docs/kubernetes.md) explica a preparacao, o acesso e os testes para a demonstracao.

Os [resultados dos testes executados](docs/resultados-testes.md) registram a validacao das APIs, persistencia, probes, RollingUpdate, HPA e balanceamento no Docker Desktop.

## Executar com Docker

Na raiz do projeto:

```powershell
Copy-Item .env.example .env
# Edite POSTGRES_PASSWORD e os demais valores se necessario.
docker compose up --build -d
docker compose ps -a
```

O Compose inicia um banco `aps`, um servico `migrate`, as tres APIs e tres clientes de verificacao. Todas as APIs recebem a mesma `DATABASE_URL`, usando o endereco interno `db:5432`. Elas iniciam somente depois que as migrations forem concluidas.

O schema e todo o historico de migrations ficam em `prisma/`. O volume `aps-db-data` guarda as tabelas de leituras `Alagamento`, `QualidadeAr` e `Transito`, e os cadastros `SensorAlagamento`, `SensorQualidadeAr` e `SensorTransito`. Os Dockerfiles usam a raiz como contexto de build, executam em multiplos estagios e usam o usuario `node` no runtime.

As portas publicadas podem ser alteradas no `.env`: `DB_PORT`, `ALAGAMENTO_API_PORT`, `QUALIDADE_AR_API_PORT` e `TRANSITO_API_PORT`.

```powershell
docker compose logs migrate client-alagamento client-qualidade-ar client-transito
Invoke-RestMethod http://localhost:3001/health/ready
Invoke-RestMethod http://localhost:3002/health/ready
Invoke-RestMethod http://localhost:3003/health/ready
```

Cada API possui `/health/live` para verificar o processo e `/health/ready` para verificar a conexao com o banco.

## Cache de sensores

No Kubernetes, `GET /get/sensores` usa Redis compartilhado pelas replicas de cada API. O resultado expira em 15 segundos e o cadastro de um sensor invalida a lista do seu dominio. As consultas de leituras continuam acessando o banco. Se o Redis falhar, a API consulta o PostgreSQL. Os endpoints e o formato do JSON foram preservados.

Fora do Kubernetes, o cache e opcional: deixe `REDIS_URL` vazio para executar sem Redis. O Compose permanece sem cache nesta etapa. Veja a [explicacao e a demonstracao do cache](docs/cache.md). RabbitMQ e um worker separado processam alertas simples; veja o [fluxo e as novas consultas](docs/alertas.md).

## Alertas assincronos

As APIs salvam um trabalho junto com cada leitura de NIVEL_CORREGO, MP25 ou OCUPACAO. O worker publica esses trabalhos no RabbitMQ e gera alertas acima dos limites de demonstracao: 150 cm, 35 microgramas/m3 e ocupacao 0,80. Cada API oferece `GET /get/alertas`, sem body, restrito ao seu dominio. Veja [execucao, falhas e exemplos no Postman](docs/alertas.md).

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

Cada simulador cadastra ou reutiliza os equipamentos pelo nome. Alagamento envia tres leituras, qualidade do ar envia quatro e transito envia tres. Cada equipamento envia uma requisicao independente com seu `sensorId`, timestamp e uma unica medida.

Defina `API_URL` para alterar o destino de um simulador, por exemplo `$env:API_URL = "http://localhost:3002"`.

Primeiro cadastre o equipamento com `POST /send/sensor` na porta da API correspondente. Exemplo de alagamento, em `http://localhost:3001/send/sensor`:

```json
{
    "nome": "sensor-nivel",
    "tipo": "NIVEL_CORREGO"
}
```

Depois envie a leitura para `POST http://localhost:3001/send/alagamento`, usando o ID retornado no cadastro:

```json
{
    "sensorId": 1,
    "timestamp": "2026-10-09T00:30:00.123Z",
    "nivelCorregoCm": 120.5
}
```

Qualidade do ar: cadastre, por exemplo, `{"nome":"sensor-mp25","tipo":"MP25","estacao":"estacao-01"}` em `POST http://localhost:3002/send/sensor`. A estacao e obrigatoria no cadastro do equipamento. Use seu ID em `POST http://localhost:3002/send/qualidade-ar`, sem repetir a estacao na leitura:

```json
{
    "sensorId": 1,
    "timestamp": "2026-10-09T00:30:00.123Z",
    "mp25": 35.2
}
```

Transito: cadastre `{"nome":"radar","tipo":"RADAR"}` em `POST http://localhost:3003/send/sensor`. Use seu ID em `POST http://localhost:3003/send/transito`:

```json
{
    "sensorId": 1,
    "timestamp": "2026-10-09T00:30:00.123Z",
    "velocidade": 42.5
}
```

| API | Tipo do sensor | Medida aceita | Exemplo de nome |
|---|---|---|---|
| Alagamento | `NIVEL_CORREGO` | `nivelCorregoCm` | `sensor-nivel` |
| Alagamento | `PLUVIOMETRO` | `chuvaAcumuladaMm` | `pluviometro` |
| Alagamento | `NIVEL_VIA` | `nivelAguaViaCm` | `sensor-nivel-via` |
| Qualidade do ar | `MP25` | `mp25` | `sensor-mp25` |
| Qualidade do ar | `CO` | `co` | `sensor-co` |
| Qualidade do ar | `NO2` | `no2` | `sensor-no2` |
| Qualidade do ar | `TEMPERATURA` | `temperatura` | `termometro` |
| Transito | `RADAR` | `velocidade` | `radar` |
| Transito | `GPS` | `posicao` | `gps` |
| Transito | `OCUPACAO` | `ocupacao` | `contador` |

Use sempre o ID retornado pela API correspondente: os cadastros sao separados por dominio dentro do mesmo banco. Cada leitura deve conter somente a medida correspondente ao tipo cadastrado. A API rejeita nomes duplicados no mesmo cadastro, sensores inexistentes e medidas misturadas. As respostas das tres APIs incluem o sensor com seu nome e tipo; os campos das outras medidas ficam `null`. O campo `veiculo` continua removido.

Os exemplos completos e os comandos PowerShell estao no [guia de sensores das tres APIs](docs/sensores.md).

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

A suite possui 38 testes de integracao: cadastro e identificacao nas tres APIs, todos os nove tipos de sensor, nomes duplicados, sensores inexistentes, uma medida por sensor, integridade no banco, timestamp do dispositivo, datas invalidas, banco compartilhado e rejeicao de corpos JSON com tipos incorretos.

## Tipagem das APIs

Cada API define seus contratos de entrada e resposta em `contracts.ts`. As rotas usam `Request` e `Response` parametrizados pelos tipos do projeto, com retorno explicito. O JSON recebido e tratado como `unknown` e validado antes que seus campos sejam usados. Dados enviados ao banco seguem os tipos gerados pelo Prisma.

As medidas de cada API formam uma uniao de tipos mutuamente exclusivos: um corpo contem somente uma medida. Misturar medidas ou informar um ID como texto produz erro de compilacao quando o contrato e usado em TypeScript e HTTP 400 quando um JSON invalido chega pela rede. O tipo do equipamento cadastrado tambem e conferido em tempo de execucao.

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

A migration `20261016010000_sensores_alagamento_qualidade_ar` aplica a mesma separacao as outras APIs: duas leituras por registro antigo de alagamento e quatro por registro de qualidade do ar. Os valores, timestamps, createdAt e estacao sao mantidos. O ID original permanece no nivel e no MP25; as outras medidas recebem novos IDs. Os cadastros gerados recebem nomes `legado:<sensor antigo>:<TIPO>` para preservar a origem e identificar a separacao. O campo textual `sensor` e substituido pelo relacionamento obrigatorio `sensorId`.

Ao atualizar uma instalacao local, execute `npm run db:migrate` e `npm run build` antes de reiniciar as APIs. No Docker, execute novamente `docker compose up --build -d`; o servico `migrate` aplica a nova migration. Os clientes devem passar a cadastrar o sensor e enviar cada medida separadamente.

### Restauracao dos sensores de alagamento

A migration `20261104000000_restaurar_sensores_alagamento` renomeia os tipos `NIVEL` e `CHUVA` para `NIVEL_CORREGO` e `PLUVIOMETRO` e acrescenta `NIVEL_VIA`/`nivelAguaViaCm`. IDs, nomes, leituras e timestamps existentes sao preservados. Clientes devem usar os novos nomes dos tipos no cadastro. Nenhuma migration antiga foi alterada.

Niveis sao medidos em cm a partir de uma referencia fixa de cada ponto. `chuvaAcumuladaMm` representa a precipitacao dos ultimos 60 minutos; leituras de janelas sobrepostas nao devem ser somadas.

Execute `npm run test:alagamento` para verificar os contratos. Com `TEST_DATABASE_URL` definido, o mesmo comando tambem verifica a preservacao de dados da migration em um schema temporario com rollback. Os testes HTTP completos continuam em `npm test`, exigindo um banco de testes com todas as migrations aplicadas.

### Restauracao dos sensores de qualidade do ar

A migration `20261104010000_restaurar_sensores_qualidade_ar` corrige `NO3`/`no3` para `NO2`/`no2` e move `estacao` para `SensorQualidadeAr`. O cadastro exige `nome`, `tipo` e `estacao`, com espacos nas extremidades removidos. Cada leitura envia `sensorId`, `timestamp` e apenas uma medida. As respostas incluem a estacao em `sensor.estacao`. Enviar `no3` ou `estacao` no corpo da leitura retorna HTTP 400.

Os quatro tipos sao `MP25`, `CO`, `NO2` e `TEMPERATURA`. Nos exemplos e simuladores, PM2.5 e NO2 usam µg/m³, CO usa ppm e temperatura usa °C.

A migration preserva IDs das leituras, valores, timestamps e createdAt. Para um sensor com uma unica estacao, mantem tambem seu ID e nome. Se o mesmo sensor tinha leituras de varios locais, a primeira estacao em ordem alfabetica fica com o cadastro original; as demais recebem novos cadastros com sufixo `:estacao:<local>` no nome. As leituras passam a apontar para o cadastro correspondente. Colisoes de nomes recebem `:` adicionais. Sensores sem leituras recebem a estacao `legado:sem-estacao`, pois nao havia local registrado. Nenhuma migration antiga foi alterada.

O simulador de qualidade do ar cadastra ou reutiliza os quatro equipamentos na `estacao-01` e informa conflito de tipo ou estacao. `npm run test:qualidade-ar` compila, verifica tipos e executa os testes dos contratos; com `TEST_DATABASE_URL`, tambem testa a migration em schemas temporarios com rollback, cobrindo banco vazio, varias estacoes e preservacao das outras APIs.
