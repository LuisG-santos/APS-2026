# APIs — guia para a apresentação

Leia também: [Docker](docker.md) · [Kubernetes](kubernetes.md).

## 1. O que a aplicação faz

O projeto recebe, armazena e consulta medições de sensores urbanos, simuladas pelo Postman ou pelos arquivos `req.py`. São três APIs independentes, feitas com **Node.js, TypeScript e Express**, usando **um único PostgreSQL 16 e o ORM Prisma 6**.

| API | Porta da aplicação | Prefixo no Ingress |
|---|---:|---|
| Alagamento e inundação | 3001 | `/alagamento` |
| Qualidade do ar | 3002 | `/qualidade-ar` |
| Trânsito e transporte | 3003 | `/transito` |

Cada API tem seu processo e tabelas de sensores e leituras. Compartilham o banco e módulos em `shared/`.

## 2. Como o código está organizado

O fluxo principal é **rota → controller → service → repository → banco**.

| Arquivo ou pasta | Responsabilidade |
|---|---|
| `index.ts` | Cria os clientes de banco/cache e inicia o servidor. |
| `app.ts` | Conecta as camadas e registra rotas. |
| `contracts.ts` | Define tipos e valida a estrutura do JSON. |
| `controllers/` | Recebe a requisição e responde com JSON e status HTTP. |
| `services/` | Normaliza dados e valida timestamp, sensor e medida. |
| `repositories/` | Acessa o Prisma e o cache de sensores. |

Passar dependências por parâmetro permite testar regras com repositories simulados.

O [schema Prisma](../../prisma/schema.prisma) descreve modelos e relações. O **Prisma Client** gera métodos de consulta em TypeScript. As **migrations** aplicam mudanças SQL versionadas ao banco. Gerar o Client não altera as tabelas.

## 3. Sensores e leituras

Primeiro cadastramos o equipamento com nome e tipo. Depois enviamos leituras com o `sensorId` retornado. Em qualidade do ar, o cadastro também exige `estacao` como texto.

| API | Tipo de sensor | Campo da leitura | Unidade ou formato |
|---|---|---|---|
| Alagamento | `NIVEL_CORREGO` | `nivelCorregoCm` | cm em relação a uma referência fixa do ponto |
| Alagamento | `PLUVIOMETRO` | `chuvaAcumuladaMm` | mm acumulados nos últimos 60 minutos |
| Alagamento | `NIVEL_VIA` | `nivelAguaViaCm` | cm em relação a uma referência fixa do ponto |
| Qualidade do ar | `MP25` | `mp25` | µg/m³ de PM2.5 |
| Qualidade do ar | `CO` | `co` | ppm |
| Qualidade do ar | `NO2` | `no2` | µg/m³ |
| Qualidade do ar | `TEMPERATURA` | `temperatura` | °C |
| Trânsito | `RADAR` | `velocidade` | valor numérico de velocidade |
| Trânsito | `GPS` | `posicao` | texto, como `-23.55,-46.63` |
| Trânsito | `OCUPACAO` | `ocupacao` | proporção: `0.80` representa 80% |

Cada requisição contém **uma única medida**, compatível com o sensor. Os outros campos retornam como `null`. Uma restrição SQL também exige exatamente uma medida por leitura.

`timestamp` é informado pelo sensor, em ISO 8601 com fuso; `createdAt` registra a gravação. A resposta inclui o objeto `sensor`. Use o ID retornado pelo cadastro naquela API.

## 4. Rotas disponíveis

Estas rotas existem **nas três APIs**:

| Método | Rota interna | Finalidade |
|---|---|---|
| POST | `/send/sensor` | Cadastrar equipamento. |
| GET | `/get/sensores` | Listar equipamentos. |
| GET | `/get/alertas` | Consultar alertas somente do domínio daquela API. |
| GET | `/health/live` | Verificar se o processo responde. |
| GET | `/health/ready` | Verificar a conexão com o banco a cada chamada. |

As rotas de leituras variam por domínio:

| API | POST: enviar leitura | GET: consultar leituras |
|---|---|---|
| Alagamento | `/send/alagamento` | `/get/alagamento` |
| Qualidade do ar | `/send/qualidade-ar` | `/get/qualidade-ar` |
| Trânsito | `/send/transito` | `/get/transito` |

No Compose: `http://localhost:3001/get/sensores`. No Kubernetes: `http://localhost:30080/alagamento/get/sensores`. O prefixo externo seleciona a API e é removido pelo Traefik.

### Exemplo no Postman

No Postman, use **Body → raw → JSON** e cadastre:

```http
POST http://localhost:30080/alagamento/send/sensor
```

```json
{ "nome": "corrego-apresentacao", "tipo": "NIVEL_CORREGO" }
```

Envie a leitura com o ID retornado (`1` é exemplo):

```http
POST http://localhost:30080/alagamento/send/alagamento
```

```json
{
  "sensorId": 1,
  "timestamp": "2026-11-05T12:00:00.000Z",
  "nivelCorregoCm": 180
}
```

Consulte `/alagamento/get/alagamento` e `/alagamento/get/alertas`, sem body. Em qualidade do ar, o cadastro exige também `estacao`.

Status: **201** criação, **400** entrada inválida, **404** sensor inexistente, **409** nome duplicado, **500** falha inesperada e **503** readiness indisponível.

## 5. Cache e alertas assíncronos

O **Redis** guarda `GET /get/sensores` por **15 segundos**, em chaves por domínio compartilhadas entre réplicas. Cadastrar um sensor invalida a chave. Se o cache falhar, consultamos PostgreSQL. O TTL limita a desatualização em concorrência; leituras continuam sendo consultadas no banco.

Um **worker**, processo separado das APIs, gera os alertas:

1. A API salva leitura e `TarefaAlerta` na mesma transação para os três tipos com regra.
2. O worker publica no RabbitMQ e remove a tarefa após confirmação do envio.
3. Consome a mensagem, compara o valor e salva um eventual `Alerta`.
4. Envia um ACK ao RabbitMQ, confirmando o processamento.

| Sensor | Condição de alerta |
|---|---|
| `NIVEL_CORREGO` | Nível **maior que 150 cm** |
| `MP25` | PM2.5 **maior que 35 µg/m³** |
| `OCUPACAO` | Ocupação **maior que 0,80** |

Os limites são de demonstração; igualdade não gera alerta. Outros tipos apenas guardam leituras. O POST responde após a gravação, sem esperar o alerta. Se fila ou worker pararem, os trabalhos aguardam. A unicidade de domínio e ID da leitura impede alertas duplicados em reenvios.

## 6. O que mostrar na apresentação

Mostre cadastro, leitura, histórico e alerta. Abra um controller, um service e um repository para relacionar o código ao fluxo. O foco é executar essa aplicação em infraestrutura distribuída.

Para detalhes: [sensores](../sensores.md), [cache](../cache.md) e [alertas](../alertas.md). Referência: [transações Prisma](https://www.prisma.io/docs/orm/prisma-client/queries/transactions).
