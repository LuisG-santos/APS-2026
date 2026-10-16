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
| Alagamento | `NIVEL` | `sensor-nivel` | `nivelCorregoCm` |
| Alagamento | `CHUVA` | `pluviometro` | `chuvaAcumuladaMm` |
| Qualidade do ar | `MP25` | `sensor-mp25` | `mp25` |
| Qualidade do ar | `CO` | `sensor-co` | `co` |
| Qualidade do ar | `NO3` | `sensor-no3` | `no3` |
| Qualidade do ar | `TEMPERATURA` | `termometro` | `temperatura` |
| Transito | `RADAR` | `radar` | `velocidade` |
| Transito | `GPS` | `gps` | `posicao` |
| Transito | `OCUPACAO` | `contador` | `ocupacao` |

Os tipos sao escritos exatamente como na tabela. As medidas sao numericas, exceto `posicao`, que e uma string. Os nomes podem ser escolhidos pelo grupo e devem ser unicos dentro do cadastro de cada API. Por exemplo, e possivel cadastrar varios pluviometros usando nomes diferentes.

## Cadastro e envio no PowerShell do VS Code

Com o banco e as APIs ativos, execute na raiz do projeto. Os exemplos usam nomes novos; se ja existirem, consulte `GET /get/sensores` e reutilize os IDs.

Alagamento: cadastro do equipamento de nivel e envio da sua leitura:

```powershell
$nivel = Invoke-RestMethod -Method Post -Uri 'http://localhost:3001/send/sensor' -ContentType 'application/json' -Body '{"nome":"nivel-teste","tipo":"NIVEL"}'
$leituraNivel = @{
  sensorId = $nivel.id
  timestamp = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  nivelCorregoCm = 120.5
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri 'http://localhost:3001/send/alagamento' -ContentType 'application/json' -Body $leituraNivel
```

Chuva: outro equipamento e outra requisicao:

```powershell
$chuva = Invoke-RestMethod -Method Post -Uri 'http://localhost:3001/send/sensor' -ContentType 'application/json' -Body '{"nome":"pluviometro-teste","tipo":"CHUVA"}'
$leituraChuva = @{
  sensorId = $chuva.id
  timestamp = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  chuvaAcumuladaMm = 35.2
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri 'http://localhost:3001/send/alagamento' -ContentType 'application/json' -Body $leituraChuva
```

Qualidade do ar: um exemplo com o equipamento MP25. O campo `estacao` identifica o local da leitura e continua obrigatorio:

```powershell
$particulas = Invoke-RestMethod -Method Post -Uri 'http://localhost:3002/send/sensor' -ContentType 'application/json' -Body '{"nome":"particulas-teste","tipo":"MP25"}'
$leituraAr = @{
  sensorId = $particulas.id
  estacao = 'estacao-01'
  timestamp = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  mp25 = 35.2
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri 'http://localhost:3002/send/qualidade-ar' -ContentType 'application/json' -Body $leituraAr
```

Para as outras medidas do ar, cadastre equipamentos com `CO`, `NO3` ou `TEMPERATURA` e envie, respectivamente, somente `co`, `no3` ou `temperatura`, alem de `sensorId`, `estacao` e `timestamp`. Nao envie os quatro valores na mesma requisicao.

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

Cada leitura retorna `sensorId` e o objeto `sensor` com `id`, `nome`, `tipo` e `createdAt`. Somente o campo medido tem valor; os outros campos de medida ficam `null` na resposta. No POST, omita esses outros campos.

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

Cada execucao envia duas, quatro e tres leituras, respectivamente. Rodar de novo cria novas leituras e reutiliza os sensores. Se um nome ja estiver cadastrado com outro tipo, o simulador informa o conflito.

Consulte o [README](../README.md) para executar o ambiente, aplicar migrations e rodar os testes de integracao e de tipagem.
