# Sensores das tres APIs

Cada equipamento e cadastrado uma vez com `nome` e `tipo`. O cadastro retorna um `id`, que deve ser enviado como `sensorId` em todas as leituras seguintes. Cada leitura representa uma unica medida do equipamento correspondente.

As tres APIs usam o mesmo banco PostgreSQL. Cada dominio possui sua tabela de sensores e sua tabela de leituras. Use o ID obtido na propria API; um ID numericamente igual em outra API pode representar outro equipamento.

| API | Porta padrao | POST de leitura | GET de leituras |
|---|---:|---|---|
| Alagamento | 3001 | `/send/alagamento` | `/get/alagamento` |
| Qualidade do ar | 3002 | `/send/qualidade-ar` | `/get/qualidade-ar` |
| Transito | 3003 | `/send/transito` | `/get/transito` |

Todas oferecem `POST /send/sensor` e `GET /get/sensores` na respectiva porta.

| API | Tipo no cadastro | Exemplo de nome | Campo enviado na leitura |
|---|---|---|---|
| Alagamento | `NIVEL_CORREGO` | `sensor-nivel` | `nivelCorregoCm` |
| Alagamento | `PLUVIOMETRO` | `pluviometro` | `chuvaAcumuladaMm` |
| Alagamento | `NIVEL_VIA` | `sensor-nivel-via` | `nivelAguaViaCm` |
| Qualidade do ar | `MP25` | `sensor-mp25` | `mp25` |
| Qualidade do ar | `CO` | `sensor-co` | `co` |
| Qualidade do ar | `NO2` | `sensor-no2` | `no2` |
| Qualidade do ar | `TEMPERATURA` | `termometro` | `temperatura` |
| Transito | `RADAR` | `radar` | `velocidade` |
| Transito | `GPS` | `gps` | `posicao` |
| Transito | `OCUPACAO` | `contador` | `ocupacao` |

Os tipos sao escritos exatamente como na tabela. As medidas sao numericas, exceto `posicao`, que e uma string. Os nomes podem ser escolhidos pelo grupo e devem ser unicos dentro do cadastro de cada API. Por exemplo, e possivel cadastrar varios pluviometros usando nomes diferentes.

## Cadastro e envio no PowerShell do VS Code

Com o banco e as APIs ativos, execute na raiz do projeto. Os exemplos usam nomes novos; se ja existirem, consulte `GET /get/sensores` e reutilize os IDs.

Alagamento: cadastro do equipamento de nivel e envio da sua leitura:

```powershell
$nivel = Invoke-RestMethod -Method Post -Uri 'http://localhost:3001/send/sensor' -ContentType 'application/json' -Body '{"nome":"nivel-teste","tipo":"NIVEL_CORREGO"}'
$leituraNivel = @{
  sensorId = $nivel.id
  timestamp = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  nivelCorregoCm = 120.5
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri 'http://localhost:3001/send/alagamento' -ContentType 'application/json' -Body $leituraNivel
```

Chuva: outro equipamento e outra requisicao:

```powershell
$chuva = Invoke-RestMethod -Method Post -Uri 'http://localhost:3001/send/sensor' -ContentType 'application/json' -Body '{"nome":"pluviometro-teste","tipo":"PLUVIOMETRO"}'
$leituraChuva = @{
  sensorId = $chuva.id
  timestamp = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  chuvaAcumuladaMm = 35.2
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri 'http://localhost:3001/send/alagamento' -ContentType 'application/json' -Body $leituraChuva
```

Nivel de agua na via: cadastre `{"nome":"nivel-via-teste","tipo":"NIVEL_VIA"}` em `/send/sensor` e envie seu ID em uma leitura independente:

```json
{
  "sensorId": 3,
  "timestamp": "2026-11-04T12:00:00Z",
  "nivelAguaViaCm": 8.0
}
```

O ID e ilustrativo; use o retornado no cadastro. Os niveis usam cm relativos a uma referencia fixa de cada ponto. A chuva acumulada usa mm nos ultimos 60 minutos. O equipamento ou simulador deve manter essas referencias.

Qualidade do ar: o campo `estacao` identifica o local do equipamento e e obrigatorio no cadastro, junto com nome e tipo:

```powershell
$particulas = Invoke-RestMethod -Method Post -Uri 'http://localhost:3002/send/sensor' -ContentType 'application/json' -Body '{"nome":"particulas-teste","tipo":"MP25","estacao":"estacao-01"}'
$leituraAr = @{
  sensorId = $particulas.id
  timestamp = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  mp25 = 35.2
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri 'http://localhost:3002/send/qualidade-ar' -ContentType 'application/json' -Body $leituraAr
```

Para as outras medidas do ar, cadastre equipamentos com `CO`, `NO2` ou `TEMPERATURA`, informando tambem sua estacao, e envie nas leituras, respectivamente, somente `co`, `no2` ou `temperatura`, alem de `sensorId` e `timestamp`. Nao envie os quatro valores na mesma requisicao.

Os exemplos de radar, GPS e contador estao em [sensores de transito](sensores-transito.md).

## Consulta e validacao

```powershell
Invoke-RestMethod 'http://localhost:3001/get/sensores'
Invoke-RestMethod 'http://localhost:3001/get/alagamento'
Invoke-RestMethod 'http://localhost:3002/get/sensores'
Invoke-RestMethod 'http://localhost:3002/get/qualidade-ar'
Invoke-RestMethod 'http://localhost:3003/get/sensores'
Invoke-RestMethod 'http://localhost:3003/get/transito'
```

Cada leitura retorna `sensorId` e o objeto `sensor` com `id`, `nome`, `tipo` e `createdAt`; qualidade do ar inclui tambem `sensor.estacao`. Na qualidade do ar, nome e estacao sao salvos sem espacos nas extremidades. PM2.5 e NO2 usam µg/m³, CO usa ppm e temperatura usa °C. O contrato antigo com `no3` ou `estacao` na leitura retorna HTTP 400. Somente o campo medido tem valor; os outros campos de medida ficam `null` na resposta. No POST, omita esses outros campos.

O equipamento gera `timestamp` imediatamente antes do envio. A API salva esse instante e o devolve em UTC. `createdAt` registra separadamente quando o banco recebeu o registro.

| Situacao | Resposta HTTP |
|---|---:|
| Sensor ou leitura cadastrado | 201 |
| Consulta concluida | 200 |
| Nome vazio, tipo desconhecido ou corpo incorreto | 400 |
| Timestamp invalido ou sem fuso | 400 |
| ID invalido, medida ausente, misturada ou incompativel | 400 |
| Sensor nao cadastrado na API consultada | 404 |
| Nome de sensor ja cadastrado nessa API | 409 |

O banco tambem exige um sensor existente e exatamente uma medida em cada leitura. Um sensor com leituras nao pode ser excluido, preservando o historico.

## Simular todos os tipos

Os scripts usam apenas a biblioteca padrao do Python, cadastram os sensores que faltarem e reutilizam os existentes pelo nome:

```powershell
python api-alagamento-inundacao/req.py
python api-qualidade-do-ar/req.py
python api-transito-e-transporte/req.py
```

Cada execucao envia tres, quatro e tres leituras, respectivamente. Rodar de novo cria novas leituras e reutiliza os sensores. Se um nome ja estiver cadastrado com outro tipo, o simulador informa o conflito. Qualidade do ar tambem verifica conflito de estacao, usando `estacao-01` nos quatro equipamentos.

Consulte o [README](../README.md) para executar o ambiente, aplicar migrations e rodar os testes de integracao e de tipagem.

## Organizacao da API de alagamento

O fluxo de uma requisicao e **rota → controller → service → repository → banco**. Sensores e leituras possuem arquivos separados em cada camada dentro de `api-alagamento-inundacao/`:

- **controllers/** recebe o JSON, valida sua estrutura com os contratos, chama o service e monta a resposta HTTP, serializando datas como strings ISO.
- **services/** concentra as regras: normalizacao do nome, validade do timestamp, existencia do equipamento e compatibilidade da medida com o tipo cadastrado. Os services recebem repositories como dependencias e retornam objetos internos, sem depender de Express.
- **repositories/** concentra as consultas e gravacoes Prisma. O repository de sensores traduz nome duplicado em erro conhecido; o de leituras inclui o sensor nos resultados e verifica a conexao com o banco.
- **errors.ts** define codigos e mensagens dos erros conhecidos, sem status HTTP. Os controllers fazem a conversao para 400, 404 ou 409. Falhas inesperadas continuam retornando 500.
- **app.ts** monta as dependencias e registra as rotas. Os handlers pequenos de health ficam aqui; readiness verifica a conexao pelo service e repository e retorna 503 quando o banco esta indisponivel.
- **contracts.ts** define tipos de entrada/resposta e valida apenas a estrutura do JSON. A regra que seleciona a medida pelo tipo esta no service de leituras. **index.ts** continua criando a conexao Prisma e iniciando o servidor.

Por exemplo, ao receber uma leitura de nivel na via, o controller valida `sensorId`, `timestamp` e `nivelAguaViaCm`; o service valida o instante e verifica se o equipamento existe e e `NIVEL_VIA`; o repository grava a leitura. O controller retorna o registro com o sensor associado e as datas serializadas.

`npm run test:alagamento` executa build, verificacao de tipos e testes dos contratos, services e controllers sem exigir banco. O teste da migration roda somente com `TEST_DATABASE_URL` configurado. Os testes de service usam repositories simulados para verificar que falhas de timestamp, sensor ou medida impedem gravacao. Os testes de controller verificam status, mensagens e serializacao. A integracao HTTP com PostgreSQL continua em `npm test`, exigindo banco de testes com migrations aplicadas.

Esta separacao foi aplicada somente a alagamento; qualidade do ar e transito mantem sua organizacao atual.
