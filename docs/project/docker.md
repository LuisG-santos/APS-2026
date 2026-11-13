# Docker — guia para a apresentação

Leia também: [APIs](api.md) · [Kubernetes](kubernetes.md).

## 1. Qual é o papel do Docker aqui

Docker empacota código, dependências e ambiente de execução em **imagens**. Um **container** é uma execução da imagem, com o mesmo ambiente em máquinas diferentes.

Cada API e o banco executam separadamente. No Kubernetes, acrescentamos Redis, RabbitMQ, Traefik, metrics-server e worker.

```text
Código + dependências → Dockerfile → imagem → container
```

Kubernetes coordena as réplicas, comunicação, recuperação e escala desses containers.

## 2. Como os Dockerfiles foram montados

Há um Dockerfile por API. O **contexto de build é a raiz do repositório**, que contém dependências, `shared/` e o schema Prisma.

Usamos `node:22-bookworm-slim`, com OpenSSL para o Prisma, e build em estágios:

| Estágio | O que faz |
|---|---|
| `build` | Executa `npm ci`, copia o código e roda `npm run build`. |
| `migrate` | Mantém a CLI Prisma para aplicar migrations. |
| `production-dependencies` | Remove dependências de desenvolvimento. |
| `runtime` | Recebe `dist/` e as dependências de execução. |
| `worker` | No Dockerfile de alagamento, inicia o worker a partir do runtime. |
| `production` | Último estágio de alagamento; mantém a API como build padrão. |

O build gera o **Prisma Client** e compila TypeScript. A URL fictícia dessa etapa não altera tabelas. Migrations executam depois, com a conexão real fornecida pelo ambiente.

O código das três APIs participa do build compartilhado. Cada container inicia o processo definido em seu `CMD`.

### Decisões que vale explicar

- `npm ci` usa as versões do lockfile.
- Copiar dependências antes do código permite reutilizar a camada de instalação.
- O runtime usa `node`, sem executar a aplicação como root.
- `.dockerignore` exclui ambientes reais, dependências locais, builds anteriores e Git.
- `EXPOSE` informa a porta; Compose e Services definem como acessá-la.

## 3. Como o Docker Compose inicia o projeto

O [docker-compose.yml](../../docker-compose.yml) organiza o ambiente de desenvolvimento:

```text
PostgreSQL saudável → migrations concluídas → três APIs → clientes de verificação
```

O banco usa `postgres:16` e o volume `aps-db-data`. `migrate` aguarda seu healthcheck e executa `npm run db:migrate`. As APIs aguardam a conclusão das migrations; clientes com curl verificam health e consultas.

Terminar os clientes com código zero é esperado. Para enviar medições, usamos `req.py` ou Postman.

Dentro do Compose, PostgreSQL é acessado por `db:5432`. Pelo computador, o padrão é `localhost:5433`; APIs usam 3001, 3002 e 3003.

### Como subir

Na primeira configuração, copie `.env.example` para `.env` e defina sua senha. No PowerShell:

```powershell
Copy-Item .env.example .env
```

No macOS/Linux: `cp .env.example .env`. Reutilize configurações locais já existentes.

Na raiz do projeto:

```sh
docker compose up --build -d
docker compose ps -a
docker compose logs migrate
docker compose logs api-alagamento
```

Teste `GET http://localhost:3001/health/ready`. `--build` constrói imagens; `-d` executa em segundo plano.

`docker compose down` remove containers e rede, mantendo o volume. Excluir o volume apaga os dados daquele ambiente.

## 4. O que muda na execução completa em Kubernetes

**O Compose atual não inicia Redis, RabbitMQ nem worker.** Leituras com regra geram trabalhos pendentes, aguardando um worker configurado.

O conjunto completo está em `k8s/`. O script [build-imagens.ps1](../../scripts/k8s/build-imagens.ps1) constrói:

| Imagem | Target usado |
|---|---|
| `aps-alagamento:etapa4-v1` | `runtime` |
| `aps-qualidade-ar:etapa4-v1` | `runtime` |
| `aps-transito:etapa4-v1` | `runtime` |
| `aps-migrate:etapa3-v5` | `migrate` |
| `aps-worker:etapa3-v5.1` | `worker` |

Exemplo de construção de uma API, sempre a partir da raiz:

```sh
docker build -f api-alagamento-inundacao/Dockerfile --target runtime -t aps-alagamento:etapa4-v1 .
```

`--target` escolhe o estágio; `-t` define nome e tag. O script produz imagens locais, usadas no Docker Desktop com kubeadm. Em outros ambientes, elas precisam ser carregadas nos nós ou publicadas em um registry acessível.

Código novo precisa de imagem nova. Atualizamos a tag nos manifests e Kubernetes substitui os pods.

## 5. O que mostrar na apresentação

Mostre os estágios do Dockerfile, as dependências no Compose e o volume. Explique como as imagens chegam à etapa de Kubernetes.

Referências: [build em múltiplos estágios](https://docs.docker.com/build/building/multi-stage/) e [guia completo do projeto em Kubernetes](../kubernetes.md).
