# APS 2026 — Monitoramento Urbano

Projeto acadêmico de Sistemas Distribuídos para receber medições de sensores urbanos, armazenar leituras e gerar alertas assíncronos. O foco da etapa atual é executar a aplicação em **Kubernetes**, demonstrando comunicação, balanceamento, recuperação, persistência e escalonamento.

São **três APIs independentes**, com **dez tipos de sensor**, conectadas ao mesmo **PostgreSQL** pelo **Prisma ORM**. Redis fornece cache compartilhado; RabbitMQ e um worker separado processam alertas.

## Documentação para o grupo

| Guia | Conteúdo |
|---|---|
| [API](docs/project/api.md) | Funcionamento, camadas, sensores, banco, rotas, cache e alertas. |
| [Docker](docs/project/docker.md) | Dockerfiles, estágios de build, imagens e Compose. |
| [Kubernetes](docs/project/kubernetes.md) | Componentes, configurações, implantação e roteiro de apresentação. |
| [Desempenho](docs/desempenho.md) | Carga POST/GET, linha de base por degraus, P50/P95/P99, distribuição por pod, recursos e gráficos. |

Roteiros técnicos: [Kubernetes](docs/kubernetes.md), [sensores](docs/sensores.md), [cache](docs/cache.md) e [fila e alertas](docs/alertas.md).

## O que está implementado

- Cadastro de sensores com nome único, tipo e ID; qualidade do ar também registra a estação.
- Recebimento de uma medida por leitura, com validação do JSON, do sensor e do timestamp.
- Consulta de sensores, leituras com sensor associado e alertas de cada domínio.
- Arquitetura controller → service → repository, com contratos TypeScript e validação em execução.
- Cache Redis de sensores, compartilhado entre réplicas, com expiração e invalidação.
- Leitura e trabalho de alerta gravados na mesma transação; processamento posterior por RabbitMQ e worker.
- Confirmações de envio e processamento, novas tentativas e proteção contra alertas duplicados.
- Dockerfiles em múltiplos estágios e Compose para desenvolvimento.
- Kubernetes com Ingress, Services, réplicas, probes, recursos, volumes, migrations, Secrets e HPA.
- Simuladores Python, testes de contratos, camadas, migrations e integrações reais.
- Coletor Python de carga concorrente, CSVs por execução e gráficos Matplotlib em PNG/PDF.

## Arquitetura

```mermaid
flowchart LR
    Cliente[Postman ou sensores simulados] --> Gateway[Ingress / Traefik]
    Gateway --> APIs[Três APIs Express]
    APIs -->|Sensores, leituras e tarefas| Banco[PostgreSQL / Prisma]
    APIs -->|Cache de sensores| Redis
    Worker -->|Consulta tarefas e salva alertas| Banco
    Worker -->|Publicação confirmada| RabbitMQ
    RabbitMQ -->|Consumo com ACK| Worker
```

As APIs usam **Node.js 22, Express 5 e TypeScript**, com **Prisma 6 e PostgreSQL 16**. Cada API roda em seu próprio processo e possui suas tabelas de sensores e leituras. Elas compartilham o banco e os módulos de infraestrutura em `shared/`.

### Organização do código

As três pastas de API seguem a mesma divisão em camadas:

```text
api-alagamento-inundacao/
api-qualidade-do-ar/
api-transito-e-transporte/
  controllers/             # JSON, respostas e status HTTP
  services/                # Normalização e regras de negócio
  repositories/            # Consultas e gravações
  contracts.ts             # Tipos e validação estrutural
  errors.ts                # Erros conhecidos da API
  app.ts                   # Conexão das camadas e rotas
  index.ts                 # Inicialização e encerramento
shared/
  alertas/                 # Regras, persistência, AMQP e worker
  cache.ts                 # Redis e cache de sensores
  http.ts                  # Tipos HTTP compartilhados
  serialization.ts         # Datas dos modelos para JSON
  validation.ts            # Validações compartilhadas
prisma/
  schema.prisma
  migrations/
k8s/                       # Manifests da aplicação completa
scripts/k8s/               # Build, geração de Secrets e verificação
tests/                     # Contratos, camadas e integrações
docs/                      # Guias e evidências
```

O fluxo é **rota → controller → service → repository → banco**. Os services recebem repositories por parâmetro, sem depender de Express nem executar consultas Prisma. O JSON chega como `unknown` e é validado antes do uso; datas são serializadas explicitamente nas respostas.

## APIs e rotas

| API | Porta padrão no Compose/local | Base pelo Ingress |
|---|---:|---|
| Alagamento e inundação | 3001 | `http://localhost:30080/alagamento` |
| Qualidade do ar | 3002 | `http://localhost:30080/qualidade-ar` |
| Trânsito e transporte | 3003 | `http://localhost:30080/transito` |

Todas oferecem estas rotas internas:

| Método | Rota | Finalidade |
|---|---|---|
| POST | `/send/sensor` | Cadastrar um equipamento. |
| GET | `/get/sensores` | Listar os equipamentos cadastrados. |
| GET | `/get/alertas` | Consultar alertas somente do domínio da API. |
| GET | `/health/live` | Verificar se o processo responde. |
| GET | `/health/ready` | Verificar a conexão com o banco a cada chamada. |

As rotas de leituras são:

| API | POST | GET |
|---|---|---|
| Alagamento | `/send/alagamento` | `/get/alagamento` |
| Qualidade do ar | `/send/qualidade-ar` | `/get/qualidade-ar` |
| Trânsito | `/send/transito` | `/get/transito` |

No Compose, consulte `http://localhost:3001/get/alagamento`. No Kubernetes, use `http://localhost:30080/alagamento/get/alagamento`: Traefik seleciona a API e remove o primeiro prefixo.

GETs não precisam de body. Os GETs atuais retornam listas; filtros, agregações e paginação não fazem parte dos endpoints implementados.

### Sensores, medidas e unidades

Primeiro cadastre o equipamento e use seu `sensorId` nas leituras. Os IDs são independentes entre domínios. O cadastro de qualidade do ar exige `estacao`; esse texto fica no sensor, sem ser repetido na leitura.

| API | Tipo | Campo da medida | Unidade ou formato |
|---|---|---|---|
| Alagamento | `NIVEL_CORREGO` | `nivelCorregoCm` | cm relativos à referência fixa do ponto |
| Alagamento | `PLUVIOMETRO` | `chuvaAcumuladaMm` | mm nos últimos 60 minutos |
| Alagamento | `NIVEL_VIA` | `nivelAguaViaCm` | cm relativos à referência fixa do ponto |
| Qualidade do ar | `MP25` | `mp25` | PM2.5 em µg/m³ |
| Qualidade do ar | `CO` | `co` | ppm |
| Qualidade do ar | `NO2` | `no2` | µg/m³ |
| Qualidade do ar | `TEMPERATURA` | `temperatura` | °C |
| Trânsito | `RADAR` | `velocidade` | valor numérico de velocidade |
| Trânsito | `GPS` | `posicao` | texto, como `-23.55,-46.63` |
| Trânsito | `OCUPACAO` | `ocupacao` | proporção: `0.80` representa 80% |

Cada POST de leitura recebe **uma única medida**, compatível com o tipo do sensor. As respostas incluem o objeto `sensor`; medidas não utilizadas ficam `null`. Há também uma restrição SQL exigindo exatamente uma medida por registro, índice por sensor/timestamp e proteção contra excluir sensores com leituras.

`timestamp` é obrigatório, informado pelo sensor em ISO 8601 com fuso. O instante é preservado; `createdAt` registra a gravação no banco. Datas inválidas ou sem fuso retornam 400. Janelas sobrepostas de chuva acumulada não devem ser somadas.

### Exemplo no Postman

Configure **Body → raw → JSON** no POST de cadastro:

```http
POST http://localhost:30080/alagamento/send/sensor
```

```json
{
  "nome": "corrego-apresentacao",
  "tipo": "NIVEL_CORREGO"
}
```

Use o ID retornado para enviar a leitura (`1` abaixo é apenas exemplo):

```http
POST http://localhost:30080/alagamento/send/alagamento
```

```json
{
  "sensorId": 1,
  "timestamp": "2026-11-06T12:00:00.000Z",
  "nivelCorregoCm": 180
}
```

Consulte `/alagamento/get/alagamento` e, após o processamento, `/alagamento/get/alertas`. Para qualidade do ar, um cadastro válido é `{"nome":"sensor-mp25","tipo":"MP25","estacao":"estacao-01"}`. O campo correto é `no2`; `no3` e `estacao` são rejeitados no corpo de leituras dessa API.

Status principais: **201** criação, **400** entrada inválida, **404** sensor inexistente, **409** nome duplicado, **500** falha inesperada e **503** readiness indisponível. Mais exemplos no [guia de sensores](docs/sensores.md).

## Cache Redis

`GET /get/sensores` usa uma chave por domínio, compartilhada entre réplicas e válida por **15 segundos**. Quando a chave não existe, o repository consulta PostgreSQL e preenche o cache. Cadastrar um sensor invalida a lista correspondente.

Redis é opcional: se estiver indisponível, a API consulta o banco. A expiração limita a desatualização em falhas de invalidação ou consultas concorrentes. Histórico de leituras e validação de sensor durante a ingestão continuam acessando PostgreSQL.

No Kubernetes, Redis possui uma réplica, sem persistência, com limite de dados de 64 MB e política `allkeys-lru`. O armazenamento pode ser reconstruído. Veja [cache e demonstração](docs/cache.md).

## Fila e alertas assíncronos

| Tipo com regra | Condição | Variável e padrão do worker |
|---|---|---|
| `NIVEL_CORREGO` | Nível maior que 150 cm | `ALERTA_NIVEL_CORREGO_CM=150` |
| `MP25` | PM2.5 maior que 35 µg/m³ | `ALERTA_MP25=35` |
| `OCUPACAO` | Ocupação maior que 0,80 | `ALERTA_OCUPACAO=0.80` |

São limites ilustrativos de demonstração. Igualdade não gera alerta; os demais tipos apenas armazenam leituras. O worker valida limites finitos e não negativos, com ocupação entre 0 e 1.

1. A API salva leitura e `TarefaAlerta` na mesma transação para esses três tipos e responde 201.
2. O worker consulta os trabalhos pendentes, publica no RabbitMQ e os remove do banco após confirmação do envio.
3. O mesmo worker consome as mensagens, aplica a regra e salva eventuais alertas.
4. Confirma o processamento com ACK. Em falha, há nova tentativa; a unicidade de `(dominio, leituraId)` impede alertas duplicados.

A fila principal é `aps.alertas.v1`; mensagens inválidas vão para `aps.alertas.invalidos.v1`. Usamos filas duráveis, mensagens persistentes, confirmação do publicador e consumo com `prefetch=1`.

Mantenha **uma réplica do worker** nesta versão. Ele publica lotes de até 100 trabalhos e aguarda um segundo quando não há tarefas ou após falhas. Se worker ou RabbitMQ pararem, as APIs continuam salvando leituras e trabalhos no banco. Não há geração retroativa para leituras anteriores à implantação dos alertas.

`GET /get/alertas` retorna `id`, `dominio`, `leituraId`, `sensorId`, `valor`, `limite`, `timestamp` e `createdAt`. O resultado é ordenado por timestamp e ID decrescentes, com `[]` quando não há alertas. Detalhes em [fila e alertas](docs/alertas.md).

## Executar a aplicação completa em Kubernetes

O ambiente de referência é **Docker Desktop com Linux containers, Kubernetes e provisionador kubeadm, com um nó**. Os recursos da aplicação ficam no namespace `aps`; metrics-server fica em `kube-system`. Para preparação local, use Docker Desktop, `kubectl`, Node.js 22 e PowerShell para os scripts existentes.

### Primeira preparação

Na raiz do repositório, em PowerShell:

```powershell
kubectl config use-context docker-desktop
kubectl get nodes
Copy-Item .env.k8s.example .env.k8s
```

Defina uma senha própria em `.env.k8s` e gere os Secrets. Se os arquivos locais já existem, reutilize-os e pule sua criação:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/k8s/gerar-secret.ps1
node scripts/k8s/gerar-secret-fila.mjs
```

O primeiro script gera `k8s/02-secret.local.yaml` para PostgreSQL; o segundo gera `k8s/02-fila-secret.local.yaml` com senha aleatória para RabbitMQ. Os arquivos reais de ambiente e Secrets locais são ignorados pelo Git. Preserve credenciais de volumes já inicializados: mudar somente o Secret não altera a senha existente no banco ou broker.

No macOS/Linux com PowerShell instalado, use `pwsh` no lugar de `powershell`. O [guia Docker](docs/project/docker.md) também mostra o build direto pela CLI.

### Build e implantação

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/k8s/build-imagens.ps1
kubectl apply -f k8s/
kubectl wait -n aps --for=condition=complete job/aps-migrate-etapa3-v5 --timeout=600s
kubectl rollout status deployment/api-alagamento -n aps --timeout=300s
kubectl rollout status deployment/api-qualidade-ar -n aps --timeout=300s
kubectl rollout status deployment/api-transito -n aps --timeout=300s
kubectl rollout status statefulset/fila -n aps --timeout=300s
kubectl rollout status deployment/worker-alertas -n aps --timeout=300s
kubectl get pods,svc,ingress,hpa,pvc -n aps
```

O script constrói cinco imagens do projeto. Elas precisam estar disponíveis aos nós; o ambiente de referência usa imagens locais. Outros provisionadores ou clusters podem exigir carregamento das imagens nos nós ou publicação em registry.

| Componente | Imagem | Organização |
|---|---|---|
| Alagamento | `aps-alagamento:etapa4-v1` | Deployment + Service; 2–10 réplicas |
| Qualidade do ar | `aps-qualidade-ar:etapa4-v1` | Deployment + Service; 2–10 réplicas |
| Trânsito | `aps-transito:etapa4-v1` | Deployment + Service; 2–10 réplicas |
| Migrations | `aps-migrate:etapa3-v5` | Job e initContainers de verificação |
| Worker | `aps-worker:etapa3-v5.1` | Deployment + Service de health; uma réplica |
| PostgreSQL | `postgres:16.14-bookworm` | StatefulSet + Service + PVC de 1 GiB |
| Redis | `redis:8.2.3-alpine` | Deployment + Service; uma réplica |
| RabbitMQ | `rabbitmq:4.3.0-alpine` | StatefulSet + Service + PVC de 1 GiB |
| Gateway | `traefik:v3.7.15` | Deployment + Service NodePort + Ingress |
| Métricas | `registry.k8s.io/metrics-server/metrics-server:v0.9.0` | Métricas para HPA e `kubectl top` |

### Comunicação e disponibilidade

- **Ingress:** entrada única por caminho, com Traefik removendo o prefixo externo e distribuindo tráfego entre endpoints prontos.
- **Services:** nomes internos estáveis, como `banco`, `cache` e `fila`.
- **ConfigMap:** portas, Redis e limites de alerta. Secrets fornecem credenciais; somente broker e worker recebem o Secret da fila.
- **Migrations:** o Job aplica mudanças; initContainers das APIs e do worker aguardam sua conclusão antes de iniciar os processos.
- **Probes:** startup acompanha a inicialização; liveness verifica o processo; readiness das APIs consulta o banco a cada chamada. No worker, readiness verifica banco e RabbitMQ.
- **Recursos:** requests e limits de CPU/memória em todos os containers, incluindo initContainers e Job.
- **RollingUpdate:** APIs usam `maxUnavailable: 0`, `maxSurge: 1`, `minReadySeconds: 5` e espera de cinco segundos no `preStop`.
- **HPA:** cada API varia entre 2 e 10 réplicas, com alvo médio de 60% do request de CPU. As APIs pedem `100m` de CPU: o alvo corresponde a aproximadamente `60m` por pod. O crescimento permite uma réplica por 30 segundos; a redução tem estabilização de 120 segundos e retira uma por 60 segundos.
- **Persistência:** PostgreSQL e RabbitMQ têm volumes retidos; Redis guarda apenas cache reconstruível. Os volumes do Kubernetes são separados do Compose.

Os Deployments das APIs deixam a quantidade de réplicas sob controle do HPA. A implantação local com um único nó, banco e broker únicos não oferece tolerância à perda da máquina inteira.

### Acesso e acompanhamento

No Docker Desktop da demonstração, use `http://localhost:30080` com os prefixos das APIs. Alternativamente:

```sh
kubectl port-forward -n aps service/aps-gateway 8080:80
```

Mantenha o terminal aberto e use `http://localhost:8080/alagamento`, `/qualidade-ar` ou `/transito`. O acesso continua passando pelo Ingress.

```sh
kubectl top pods -n aps
kubectl get hpa -n aps
kubectl logs -n aps deployment/aps-gateway --tail=30
kubectl logs -n aps deployment/worker-alertas --tail=30
```

Os logs JSON de Traefik mostram o backend em `ServiceAddr`, permitindo associar requisições aos IPs dos pods. O roteiro completo está em [Kubernetes](docs/kubernetes.md).

## Executar com Docker Compose

O Compose sobe **PostgreSQL, migrations, três APIs e clientes curl de verificação**. Redis, RabbitMQ e worker estão na configuração Kubernetes; não são iniciados pelo Compose atual. Nesse modo, os GETs funcionam sem cache e tarefas de alerta aguardam um worker configurado.

Na primeira configuração, copie `.env.example` para `.env` e ajuste a senha. No PowerShell, use `Copy-Item .env.example .env`; no macOS/Linux, `cp .env.example .env`. Reutilize configurações existentes.

```sh
docker compose up --build -d
docker compose ps -a
docker compose logs migrate client-alagamento client-qualidade-ar client-transito
```

O banco precisa estar saudável para executar migrations; as APIs aguardam sua conclusão. Clientes encerrados com código zero indicam que as verificações terminaram com sucesso.

A conexão interna usa `db:5432`. No computador, o padrão é PostgreSQL em `localhost:5433` e APIs em 3001, 3002 e 3003. Essas portas podem ser alteradas pelas variáveis do `.env.example`.

Os Dockerfiles usam Node.js 22, build em múltiplos estágios, `npm ci`, geração do Prisma Client, compilação para `dist/`, remoção de dependências de desenvolvimento e usuário `node` no runtime. O contexto de build é a raiz do projeto. As tags do Compose são `1.1.0`, separadas das tags de implantação Kubernetes.

`docker compose down` preserva o volume `aps-db-data`; removê-lo também apaga os dados desse ambiente. Consulte o [guia Docker](docs/project/docker.md).

## Desenvolvimento local e simuladores

Para rodar as APIs fora dos containers, configure `DATABASE_URL` no ambiente local. Com o PostgreSQL do Compose:

```sh
npm ci
docker compose up -d --wait db
npm run db:migrate
npm run build
```

Inicie em terminais separados:

```sh
npm run dev:alagamento
npm run dev:qualidade-ar
npm run dev:transito
```

Com Redis configurado em `REDIS_URL`, o cache é habilitado. Para processar alertas localmente, configure também RabbitMQ em `RABBITMQ_URL` e inicie `npm run dev:worker`. Após build, o comando de produção é `npm run start:worker`. O health do worker usa `WORKER_PORT`, padrão 3004, e fica interno no Kubernetes.

Os simuladores usam apenas a biblioteca padrão do Python 3:

```sh
python3 api-alagamento-inundacao/req.py
python3 api-qualidade-do-ar/req.py
python3 api-transito-e-transporte/req.py
```

Eles cadastram ou reutilizam sensores, verificam conflitos e enviam uma leitura por tipo: três de alagamento, quatro de qualidade do ar e três de trânsito. Cada envio gera o timestamp atual com fuso UTC. Não são geradores de carga.

Para apontar ao Kubernetes, defina `API_URL` com o prefixo correto. Exemplo em bash/zsh:

```sh
API_URL=http://localhost:30080/alagamento python3 api-alagamento-inundacao/req.py
```

No PowerShell, defina `$env:API_URL` antes de executar Python. Para as demais APIs, use `/qualidade-ar` ou `/transito`. O script [carga.mjs](scripts/k8s/carga.mjs) é separado e gera requisições HTTP concorrentes para demonstrações de infraestrutura.

## Configuração de ambiente

| Variável | Uso |
|---|---|
| `DATABASE_URL` | Conexão Prisma com o PostgreSQL. |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | Preparação do banco/Compose; Kubernetes usa ConfigMap e Secret. |
| `DB_PORT`, `ALAGAMENTO_API_PORT`, `QUALIDADE_AR_API_PORT`, `TRANSITO_API_PORT` | Portas publicadas pelo Compose. |
| `PORT` | Porta do processo de cada API; os padrões são 3001, 3002 e 3003. |
| `REDIS_URL` | Cache opcional das APIs; vazio desabilita. |
| `RABBITMQ_URL` | Conexão exigida pelo worker. |
| `WORKER_PORT` | Porta HTTP de health do worker. |
| `ALERTA_NIVEL_CORREGO_CM`, `ALERTA_MP25`, `ALERTA_OCUPACAO` | Limites usados na inicialização do worker. |
| `API_URL` | Destino dos simuladores Python. |

Modelos: [.env.example](.env.example) para desenvolvimento/Compose e [.env.k8s.example](.env.k8s.example) para preparar as credenciais do banco no Kubernetes. Os limites do cluster ficam em [01-configmap.yaml](k8s/01-configmap.yaml); alterações nas variáveis exigem reiniciar os processos correspondentes.

## Banco, migrations e compatibilidade

O [schema](prisma/schema.prisma) contém três modelos de sensores, três de leituras e os modelos compartilhados `TarefaAlerta` e `Alerta`. Os nomes de sensores são únicos dentro de seu cadastro. A estação pertence a `SensorQualidadeAr`.

O histórico de [migrations](prisma/migrations) inclui a separação de sensores, os tipos `NIVEL_CORREGO`, `PLUVIOMETRO` e `NIVEL_VIA`, a correção de `NO3/no3` para `NO2/no2`, a estação no cadastro e a criação aditiva de tarefas/alertas. As migrations antigas permanecem versionadas. As restaurações recentes preservam dados existentes; detalhes dos cadastros legados estão no [guia de sensores](docs/sensores.md).

`npm run db:migrate` aplica migrations pendentes com `prisma migrate deploy`. `npm run db:generate` gera o Client; `npm run build` gera o Client e compila TypeScript. Gerar o Client não aplica alterações nas tabelas. Use as migrations antes de iniciar uma versão que depende da nova estrutura.

## Carga e gráficos de desempenho

O novo coletor envia leituras para as três APIs pelo Ingress, cadastra sensores próprios antes da medição e consulta o Kubernetes somente para observar réplicas e HPA. O perfil padrão dura 30 segundos com concorrência 2 por API. Os dados gerados permanecem identificados no banco.

Com Python 3.9 ou superior, prepare um ambiente virtual e instale as dependências:

~~~sh
python3 -m venv .venv-desempenho
source .venv-desempenho/bin/activate
python -m pip install -r scripts/desempenho/requirements.txt
python scripts/desempenho/carga.py
~~~

Depois, use a pasta indicada pelo coletor:

~~~sh
python scripts/desempenho/graficos.py evidencias/desempenho/ID_DA_EXECUCAO
~~~

São gerados P50/P95/P99 de respostas válidas, sucessos e falhas por segundo, taxa de erros e réplicas desejadas/prontas, além de gráficos por número de trabalhadores e PDF consolidado. O coletor registra X-Pod/X-Versao, CPU/memória de todos os pods, série por segundo com horário UTC e resumo por degrau/repetição.

O perfil base usa degraus 1, 2, 4, 8, 16, 32 e 64, 25 segundos cada, 5 de aquecimento descartados e três repetições. Exige uma réplica das três APIs, HPA removido e imagens atualizadas com X-Pod; **o script só verifica, não prepara nem altera o cluster**. A medição real de saturação e a conclusão do gargalo continuam necessárias para preencher a ficha. Para o procedimento, veja [linha de base e evidências](docs/desempenho.md#linha-de-base-da-etapa-4).

~~~sh
# Somente depois de preparar a linha de base conforme o guia:
python scripts/desempenho/carga.py --api alagamento --perfil base
# Consulta de sensores, com cadastro estável e cache:
python scripts/desempenho/carga.py --api alagamento --metodo GET -c 8 -d 20
# Gerar e copiar evidências escolhidas para uma pasta versionável:
python scripts/desempenho/graficos.py evidencias/desempenho/ID_DA_EXECUCAO --publicar evidencias/base/ID_DA_EXECUCAO
~~~

O perfil progressivo continua disponível separadamente, com HPA permitido. A validação curta não comprova capacidade máxima ou crescimento automático. CSVs brutos são preservados e a análise não inventa gargalos: candidatos a degradação são indicativos para revisar as medições. Veja [instalação no Windows, perfis, arquivos e interpretação](docs/desempenho.md).

A [campanha real da Etapa 4, de 13/11/2026](evidencias/base/etapa4-20261113T134526Z/README.md) inclui distribuição por pod, base POST/GET, gráficos, CSVs e evidência de CPU/throttling. Os testes identificaram degradação e reinícios do gateway nos extremos; a análise registra também o efeito da recuperação entre repetições. As APIs estão na imagem etapa4-v1 e os HPAs foram restaurados após a medição.

Para testar os scripts sem cluster:

~~~sh
python -m unittest discover -s tests -p 'test_desempenho.py' -v
~~~

## Testes e verificações

| Comando | Verificação |
|---|---|
| `npm run build` | Geração do Prisma Client e compilação. |
| `npm run typecheck` | Contratos e casos esperados de erro TypeScript. |
| `npm run db:validate` | Validação do schema Prisma. |
| `npm run test:alagamento` | Contratos, services, controllers e migration de alagamento. |
| `npm run test:qualidade-ar` | Contratos, services, controllers e migration de qualidade do ar. |
| `npm run test:transito` | Contratos, services e controllers de trânsito. |
| `npm run test:cache` | Cache, invalidação, isolamento, expiração e transporte Redis. |
| `npm run test:alertas` | Regras, configuração, mensagens, migration e integração de alertas. |
| `npm test` | Build, tipos e suíte completa, com arquivos em sequência. |

As suítes específicas podem rodar sem serviços externos, ignorando integrações cujas variáveis não estão definidas. A suíte principal **exige `TEST_DATABASE_URL`**, pois inclui testes HTTP com PostgreSQL real.

| Variável de teste | Requisito |
|---|---|
| `TEST_DATABASE_URL` | Banco exclusivo de testes com todas as migrations aplicadas. |
| `TEST_REDIS_URL` | Instância Redis exclusiva; o teste limpa suas chaves de sensores. |
| `TEST_RABBITMQ_URL` | Broker exclusivo; a integração de alertas limpa suas filas. Requer também PostgreSQL. |

Para a suíte completa sem testes ignorados, prepare os três serviços e configure as três variáveis. Exemplo em bash/zsh, substituindo usuários, senhas e endereços de teste:

```sh
export TEST_DATABASE_URL='postgresql://USUARIO:SENHA@localhost:5433/aps_test'
export TEST_REDIS_URL='redis://localhost:16379'
export TEST_RABBITMQ_URL='amqp://USUARIO:SENHA@localhost:15673?heartbeat=5'
DATABASE_URL="$TEST_DATABASE_URL" npm run db:migrate
npm test
```

No PowerShell, variáveis de ambiente usam `$env:NOME = 'valor'`; aponte `DATABASE_URL` para o banco de testes ao aplicar suas migrations. Use somente instâncias exclusivas para essas integrações.

A cobertura inclui os dez tipos de sensor, normalização, nomes duplicados, sensor inexistente, medidas incompatíveis/misturadas, timestamps, serialização, integridade SQL, rollback de leitura/trabalho, limites de alerta, reentrega, idempotência e isolamento dos domínios.

### Validações registradas e pendências da apresentação

A última execução completa registrada em **05/11/2026 teve 131 testes aprovados, sem falhas nem casos ignorados**, com PostgreSQL, Redis e RabbitMQ exclusivos de testes. Build e tipos também passaram. No cluster, foram conferidos cache, worker parado, interrupção/recuperação do RabbitMQ, reenvio sem alertas duplicados e preservação dos dados existentes. A revisão final do worker repetiu as verificações de mensagens inválidas. Veja [alertas](docs/alertas.md) e [cache](docs/cache.md).

Para fechar as evidências atuais da ficha de Kubernetes, ainda é necessário registrar:

- Dez requisições pelo Ingress identificando diferentes pods pelos logs.
- Tempo de substituição de um pod de API excluído.
- Persistência ao recriar o pod do PostgreSQL e readiness sem reinícios ao parar o banco.
- Escala manual para quatro réplicas, coordenada com o HPA.
- Aumento automático acima das duas réplicas iniciais sob carga.

O script [testar.mjs](scripts/k8s/testar.mjs) cobre verificações de infraestrutura e **interrompe temporariamente o banco**, recria pods e gera carga. Planeje sua execução em ambiente de demonstração/testes e a restauração dos serviços.

Os [resultados de 17/10/2026](docs/resultados-testes.md) e o [JSON daquela execução](docs/evidencias-etapa3.json) são evidências históricas da `etapa3-v1`, com configuração de HPA diferente da atual. Eles não substituem a nova demonstração. A disponibilidade das APIs depende de o cluster estar ligado; os testes de aplicação também não substituem as verificações de infraestrutura.
