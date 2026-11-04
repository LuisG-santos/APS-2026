# APS 2026 - Monitoramento Urbano

Tres APIs em Node.js, Express, TypeScript e Prisma conectadas ao mesmo banco PostgreSQL 16.

| API | Porta padrao | Consulta | Envio |
|---|---:|---|---|
| Alagamento e inundacao | 3001 | `/get/alagamento` | `/send/alagamento` |
| Qualidade do ar | 3002 | `/get/qualidade-ar` | `/send/qualidade-ar` |
| Transito e transporte | 3003 | `/get/transito` | `/send/transito` |

Cada API tambem oferece `POST /send/sensor` para cadastrar equipamentos com nome e tipo, e `GET /get/sensores` para listar os sensores cadastrados.

## Executar com Docker

Na raiz do projeto:

```powershell
Copy-Item .env.example .env
# Edite POSTGRES_PASSWORD e os demais valores se necessario.
docker compose up --build -d
docker compose ps -a
```

O Compose inicia um banco `aps`, um servico `migrate`, as tres APIs e tres clientes de verificacao. Todas as APIs recebem a mesma `DATABASE_URL`, usando o endereco interno `db:5432`. Elas iniciam somente depois que as migrations forem concluidas.

O schema e todo o historico de migrations ficam em `prisma/`. O volume `aps-db-data` guarda as tabelas `Alagamento`, `QualidadeAr`, `Transito` e seus respectivos cadastros de sensores. Os Dockerfiles usam a raiz como contexto de build, executam em multiplos estagios e usam o usuario `node` no runtime.

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

As APIs de alagamento e qualidade do ar seguem o mesmo fluxo de transito: cadastrar o sensor uma vez, reutilizar o ID e enviar uma unica medida por requisicao.

### Alagamento — porta 3001

`POST /send/sensor`:

```json
{ "nome": "nivel-corrego-01", "tipo": "NIVEL_CORREGO" }
```

`POST /send/alagamento`, usando o ID retornado:

```json
{ "sensorId": 1, "timestamp": "2026-11-04T12:00:00.123Z", "nivelCorregoCm": 120.5 }
```

| Tipo | Campo | Unidade e referencia |
|---|---|---|
| `NIVEL_CORREGO` | `nivelCorregoCm` | cm relativos a uma referencia fixa por ponto |
| `PLUVIOMETRO` | `chuvaAcumuladaMm` | mm acumulados nos ultimos 60 minutos |
| `NIVEL_VIA` | `nivelAguaViaCm` | cm relativos a uma referencia fixa por ponto na via |

A janela de chuva e fixa: nao somar leituras sucessivas de janelas sobrepostas como se fossem periodos independentes. A referencia dos niveis deve ser mantida pelo equipamento/simulador.

### Qualidade do ar — porta 3002

`POST /send/sensor`:

```json
{ "nome": "particulas-01", "tipo": "MP25", "estacao": "estacao-01" }
```

`POST /send/qualidade-ar`, usando o ID retornado:

```json
{ "sensorId": 1, "timestamp": "2026-11-04T12:00:00.123Z", "mp25": 35.2 }
```

| Tipo | Campo | Unidade |
|---|---|---|
| `MP25` | `mp25` | µg/m³ de PM2.5 |
| `CO` | `co` | ppm de monoxido de carbono |
| `NO2` | `no2` | µg/m³ de dioxido de nitrogenio |
| `TEMPERATURA` | `temperatura` | °C |

`estacao` e um texto obrigatorio no cadastro do sensor, sem tabela adicional. O antigo campo `no3` foi corrigido para `no2`.

Nas duas APIs, `GET /get/sensores` lista os cadastros. `GET /get/alagamento` e `GET /get/qualidade-ar` retornam as leituras com `sensorId`, objeto `sensor` e medidas nao utilizadas como `null`. Nomes sao unicos dentro de cada API. Campos `nome` e `estacao` sao salvos sem espacos nas extremidades.

Cadastro valido e leitura valida retornam 201; entrada invalida, medidas misturadas ou tipo incompativel retornam 400; sensor inexistente retorna 404; nome duplicado retorna 409. O POST de leitura exige `sensorId` numerico inteiro positivo, timestamp e exatamente uma medida numerica finita.

Os simuladores atuais cadastram ou reutilizam cada sensor e enviam uma leitura por tipo. Reexecuta-los gera novas leituras, reutilizando os cadastros. Conflitos de tipo ou estacao sao informados. O script de carga fica para uma etapa futura.

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

O sensor deve estar cadastrado, e cada leitura deve conter somente a medida correspondente ao seu tipo. A API rejeita nomes duplicados, sensores inexistentes e medidas misturadas. As respostas de leituras incluem o sensor com seu nome e tipo; os campos das outras medidas ficam `null`. O campo `veiculo` continua removido.

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

A suite possui testes de integracao para: timestamp do sensor, datas invalidas, cadastro e identificacao dos equipamentos, nomes duplicados, sensores inexistentes, uma medida por sensor, banco compartilhado e rejeicao de corpos JSON com tipos incorretos.

## Tipagem das APIs

Cada API define seus contratos de entrada e resposta em `contracts.ts`. As rotas usam `Request` e `Response` parametrizados pelos tipos do projeto, com retorno explicito. O JSON recebido e tratado como `unknown` e validado antes que seus campos sejam usados. Dados enviados ao banco seguem os tipos gerados pelo Prisma.

As medidas de cada API formam uma uniao de tipos mutuamente exclusivos: um corpo pode conter somente uma das medidas previstas para aquela API. Misturar medidas ou informar um ID como texto produz erro de compilacao quando o contrato e usado em TypeScript e HTTP 400 quando um JSON invalido chega pela rede. O tipo do equipamento cadastrado tambem e conferido em tempo de execucao.

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

### Migracao dos sensores de alagamento e qualidade do ar

A migration `20261104000000_sensores_alagamento_qualidade_ar` apaga as leituras antigas de `Alagamento` e `QualidadeAr` antes de trocar o contrato. Esse reinicio foi escolhido para os dados de desenvolvimento. As leituras e cadastros de transito sao preservados. O historico de migrations permanece intacto. Os clientes dessas duas APIs devem passar a cadastrar sensores e enviar `sensorId` com uma unica medida; o JSON antigo deixa de ser aceito.

`npm test` tambem verifica a migration em schemas temporarios, com rollback, cobrindo banco vazio e leituras antigas e conferindo a preservacao de transito. Requer `TEST_DATABASE_URL` com permissao para criar schemas.

## Organizacao das APIs em camadas

As tres APIs usam o fluxo **rota → controller → service → repository → banco**. Cada uma tem pastas `controllers/`, `services/` e `repositories/`, com arquivos separados para sensores e leituras.

- **Controller:** valida o formato do JSON, chama o service, converte erros conhecidos em status HTTP e serializa datas na resposta.
- **Service:** normaliza nome/estacao, valida o timestamp e verifica se o sensor existe e pode enviar aquela medida. Recebe repositories como dependencias e retorna os objetos internos, sem depender de Express.
- **Repository:** concentra consultas e gravacoes com Prisma. Traduz nome duplicado para um erro conhecido da aplicacao.
- **app.ts:** conecta as camadas, configura Express e registra as rotas. Os handlers pequenos de health ficam aqui; readiness verifica a conexao pelo service e repository de leituras.
- **contracts.ts:** define entradas, respostas e validacao estrutural. **index.ts:** cria o Prisma Client e inicia o servidor.

`shared/errors.ts` define os erros conhecidos, com codigo e mensagem, sem status HTTP. Cada API tem suas proprias camadas; nao ha repository generico nem framework de injecao de dependencias. A funcao `createApp(prisma)` continua recebendo a conexao usada na inicializacao e nos testes.

`npm run test:services` compila o projeto e executa os testes dos services com repositories simulados, sem precisar de PostgreSQL. Eles verificam regras que impedem gravacao, normalizacao de cadastro, delegacao das consultas e preservacao do timestamp. `npm test` tambem executa esses testes, alem dos contratos e da integracao com o banco.
