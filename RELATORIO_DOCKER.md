# Relatorio de Evidencias Docker

> Status: historico da arquitetura anterior com tres pilhas independentes, coletado em 25/09/2026. Nao use os tamanhos, nomes de containers ou resultados abaixo como evidencia da arquitetura atual de banco unico. Reexecute as medicoes depois que o Docker Desktop estiver disponivel.

Data da coleta: 25/09/2026

## 1. Imagens produzidas

Comando executado:

```powershell
docker image ls --format "{{.Repository}}`t{{.Tag}}`t{{.Size}}"
```

Saida relevante:

```text
aps-alagamento          1.0.0  681MB
aps-alagamento-migrate  1.0.0  1.42GB
aps-qualidade-ar        1.0.0  681MB
aps-qualidade-ar-migrate 1.0.0 1.42GB
aps-transito            1.0.0  681MB
aps-transito-migrate    1.0.0  1.42GB
node                    22-bookworm-slim 329MB
```

As imagens `aps-*-migrate` correspondem ao estagio de migracao do Dockerfile. As imagens `aps-*` sao as imagens finais de runtime das APIs.

## 2. Comparacao de tamanhos e multi-stage

| Comparacao | Tamanho | Diferenca | Interpretacao |
|---|---:|---:|---|
| Imagem base `node:22-bookworm-slim` | 329MB | - | Base de runtime usada pelas APIs. |
| Imagem final de cada API | 681MB | +352MB | Inclui aplicacao compilada, Prisma gerado e dependencias de producao. |
| Imagem de migracao de cada API | 1.42GB | +739MB em relacao ao runtime | Contem o ambiente necessario para executar migrations. |

A comparacao base-final mostra que a aplicacao adiciona 352MB a imagem Node. Ela nao e, isoladamente, uma prova de reducao, pois a imagem final precisa conter as dependencias de producao.

A evidencia numerica do multi-stage e a comparacao entre os alvos do mesmo Dockerfile: a imagem final de runtime possui 681MB, enquanto a imagem de migracao possui 1.42GB. Portanto, o runtime final reduz aproximadamente 739MB, ou 52%, em relacao ao estagio de migracao.

## 3. Execucao como usuario nao-root

Comandos executados sem forcar usuario:

```powershell
Set-Location api-alagamento-inundacao; docker compose exec -T api id
Set-Location ..\api-qualidade-do-ar; docker compose exec -T api id
Set-Location ..\api-transito-e-transporte; docker compose exec -T api id
```

Saida nas tres APIs:

```text
uid=1000(node) gid=1000(node) groups=1000(node)
```

O UID `1000` e diferente de `0`, comprovando que os containers de runtime nao executam como root.

## 4. Estado das pilhas

Comando executado em cada pasta da API:

```powershell
docker compose ps -a
```

Saida resumida:

```text
api-alagamento-inundacao
api      aps-alagamento:1.0.0       Up (healthy)
db       postgres:16                Up (healthy)
migrate  aps-alagamento-migrate:1.0.0 Exited (0)
client   curlimages/curl:8.12.1     Exited (0)

api-qualidade-do-ar
api      aps-qualidade-ar:1.0.0     Up (healthy)
db       postgres:16                Up (healthy)
migrate  aps-qualidade-ar-migrate:1.0.0 Exited (0)
client   curlimages/curl:8.12.1     Exited (0)

api-transito-e-transporte
api      aps-transito:1.0.0         Up (healthy)
db       postgres:16                Up (healthy)
migrate  aps-transito-migrate:1.0.0 Exited (0)
client   curlimages/curl:8.12.1     Exited (0)
```

`migrate` e `client` sao servicos de execucao unica. O codigo de saida `0` comprova que concluiram com sucesso; `db` e `api` permanecem saudaveis em execucao.

## 5. Tempo de construcao

Cada medicao foi realizada com `docker compose build` e, em seguida, com `docker compose build --no-cache`.

| API | Com cache | Sem cache |
|---|---:|---:|
| Alagamento e Inundacao | 00:00:02.651 | 00:02:20.377 |
| Qualidade do Ar | 00:00:03.094 | 00:02:12.229 |
| Transito e Transporte | 00:00:03.251 | 00:01:58.468 |

Os tres builds terminaram com status `OK`. O cache de camadas reduz o tempo de construcao de aproximadamente dois minutos para aproximadamente tres segundos nas repeticoes sem alteracao de codigo ou dependencias.

## 6. Persistencia apos reinicializacao

Procedimento executado em cada pilha:

1. Envio de um registro unico por `POST` para a API.
2. Consulta do registro por `GET`.
3. Execucao de `docker compose restart` na pasta da pilha.
4. Nova consulta pelo mesmo `GET`.

Resultado observado:

| API | Identificador criado | Antes do restart | Depois do restart |
|---|---:|---|---|
| Alagamento e Inundacao | 4 | Registro encontrado | Registro encontrado |
| Qualidade do Ar | 2 | Registro encontrado | Registro encontrado |
| Transito e Transporte | 2 | Registro encontrado | Registro encontrado |

Os registros foram criados com identificadores unicos de evidencia de persistencia e continuaram acessiveis apos `docker compose restart`. Isso comprova que os dados estao armazenados nos volumes nomeados do PostgreSQL, e nao apenas na memoria dos containers.

Rotas utilizadas:

```text
POST/GET http://localhost:3001/send/alagamento /get/alagamento
POST/GET http://localhost:3002/send/qualidade-ar /get/qualidade-ar
POST/GET http://localhost:3003/send/transito /get/transito
```