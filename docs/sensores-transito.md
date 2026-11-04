# Sensores de transito

O cadastro de equipamentos tambem esta disponivel em alagamento e qualidade do ar. Consulte o [guia das tres APIs](sensores.md) para os tipos e exemplos desses dominios.

Cada equipamento tem um cadastro com `id`, `nome` unico e `tipo`. O tipo determina qual medida ele pode enviar:

Os contratos TypeScript estao em `api-transito-e-transporte/contracts.ts`. Eles exigem um `sensorId` numerico, timestamp em texto e somente uma medida. O JSON recebido pela rede e validado antes do uso; a tipagem nao substitui essa validacao.

| Tipo | Exemplo de nome | Campo da leitura |
|---|---|---|
| RADAR | radar | velocidade |
| GPS | gps | posicao |
| OCUPACAO | contador | ocupacao |

Todos os endpoints desta pagina pertencem a API da porta 3003. O banco PostgreSQL continua compartilhado pelas tres APIs.

## 1. Cadastrar o equipamento

`POST /send/sensor`

```json
{
  "nome": "radar",
  "tipo": "RADAR"
}
```

Resposta HTTP 201:

```json
{
  "id": 1,
  "nome": "radar",
  "tipo": "RADAR",
  "createdAt": "2026-10-16T12:00:00.000Z"
}
```

Os nomes e IDs dos exemplos sao ilustrativos. Use sempre o ID efetivamente retornado. Nomes duplicados retornam HTTP 409. Nome vazio e tipo desconhecido retornam HTTP 400.

Para listar os equipamentos cadastrados: `GET /get/sensores`.

## 2. Enviar uma leitura

`POST /send/transito`

Radar, usando seu ID:

```json
{
  "sensorId": 1,
  "timestamp": "2026-10-16T12:01:00.123Z",
  "velocidade": 42.5
}
```

GPS, depois de cadastra-lo com `tipo: "GPS"`:

```json
{
  "sensorId": 2,
  "timestamp": "2026-10-16T12:01:00.456Z",
  "posicao": "-23.5505,-46.6333"
}
```

Contador, depois de cadastra-lo com `tipo: "OCUPACAO"`:

```json
{
  "sensorId": 3,
  "timestamp": "2026-10-16T12:01:00.789Z",
  "ocupacao": 0.75
}
```

Cada sensor gera seu timestamp imediatamente antes do envio. A API valida e salva esse instante, sem substitui-lo pelo horario do servidor. Uma leitura com as tres medidas juntas retorna HTTP 400. Um sensor nao cadastrado retorna HTTP 404.

O cadastro e feito uma vez por equipamento. As leituras seguintes reutilizam seu `sensorId`.

## 3. Consultar

`GET /get/transito` retorna as leituras com o objeto `sensor`, incluindo `id`, `nome` e `tipo`. Apenas o campo enviado contem uma medida; os outros dois ficam `null`. Isso representa uma medida por registro, vinculada ao equipamento que a enviou.

## Testar no PowerShell

Com a API ativa:

```powershell
$radar = Invoke-RestMethod -Method Post -Uri 'http://localhost:3003/send/sensor' -ContentType 'application/json' -Body '{"nome":"radar-teste","tipo":"RADAR"}'

$leitura = @{
  sensorId = $radar.id
  timestamp = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  velocidade = 42.5
} | ConvertTo-Json

Invoke-RestMethod -Method Post -Uri 'http://localhost:3003/send/transito' -ContentType 'application/json' -Body $leitura
Invoke-RestMethod 'http://localhost:3003/get/sensores'
Invoke-RestMethod 'http://localhost:3003/get/transito'
```

Se `radar-teste` ja estiver cadastrado, consulte `GET /get/sensores` e reutilize seu ID. Para uma simulacao completa de radar, GPS e contador, execute na raiz:

```powershell
python api-transito-e-transporte/req.py
```

O simulador reutiliza os nomes ja cadastrados e envia tres requisicoes de leitura independentes. Se algum desses nomes estiver cadastrado com um tipo diferente, informa o conflito.

## Organizacao em camadas

A API segue **rota → controller → service → repository → banco**, com arquivos separados para sensores e leituras em `controllers/`, `services/` e `repositories/`.

O controller valida o formato do JSON e monta as respostas HTTP; o service normaliza o nome do equipamento, valida o timestamp e verifica se a medida e compativel com o sensor cadastrado; o repository executa as consultas Prisma. `errors.ts` define codigos e mensagens de erros conhecidos, que os controllers convertem para 400, 404 ou 409. `app.ts` conecta as camadas, registra as rotas e mantem os handlers pequenos de health. `createApp(prisma)` e a inicializacao por `index.ts` continuam iguais.

`npm run test:transito` executa build, verificacao de tipos e testes dos contratos, services e controllers sem precisar de banco. A integracao HTTP com PostgreSQL continua em `npm test`, exigindo `TEST_DATABASE_URL` com migrations aplicadas. A descricao das responsabilidades comuns esta no [guia das tres APIs](sensores.md#organizacao-das-tres-apis).
