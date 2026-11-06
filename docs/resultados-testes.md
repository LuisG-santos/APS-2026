# Resultados dos testes - Etapa 3

Validacao executada em 17/10/2026, no Windows com Docker Desktop, Linux containers, Kubernetes 1.36.1 (kubeadm, um node) e PostgreSQL 16.14. As imagens locais usaram a tag fixa `etapa3-v1`.

## Testes funcionais

| Verificacao | Resultado observado |
|---|---|
| Build e contratos TypeScript | Aprovados no Windows e dentro da imagem Linux |
| Suite de integracao | 38 testes aprovados, zero falhas, em cada ambiente, com PostgreSQL real |
| Instalacao nova | Quatro migrations aplicadas; schema sem divergencias |
| Atualizacao de dados existentes | Medidas separadas por sensor sem perder valores, zeros, timestamps, createdAt, estacao e IDs originais; reaplicar migrations nao duplicou dados |
| Banco compartilhado | As tres APIs consultaram o mesmo banco `aps`, com tres tabelas de sensores e tres de leituras |
| Nove tipos de sensor pelo Ingress | Cadastro, leitura e consulta aprovados; cada leitura preservou apenas a medida do sensor correspondente |
| Rejeicao de entradas | Nome duplicado retornou 409; sensor inexistente, 404; medidas misturadas e corpos invalidos, 400 |
| Timestamp do dispositivo | O timestamp enviado foi devolvido sem alterar o instante; createdAt registrou a gravacao separadamente |
| Simuladores Python pelo NodePort 30080 | Duas execucoes por API: 4 leituras de alagamento, 8 de qualidade do ar e 6 de transito; sensores reutilizados e timestamps preservados |
| Docker Compose | Configuracao validada. A execucao dos containers desta etapa foi feita no Kubernetes |

## Kubernetes

| Verificacao | Resultado observado |
|---|---|
| Manifests | 35 recursos validados com kubeconform em modo strict, incluindo os modelos de Secret; dry-run no servidor aprovado |
| Inicializacao | Job de migrations concluido; banco, APIs, gateway e API de metricas disponiveis; PVC Bound |
| Persistencia | Pod `banco-0` excluido e recriado com outro UID; mesmo PVC; nove leituras preservadas |
| Falha do banco | Nas tres APIs: liveness 200, readiness 503, mesmo Pod e mesmo numero de restarts; recuperacao apos restaurar o banco |
| RollingUpdate | 204 requisicoes bem-sucedidas, zero falhas, durante 23 segundos de troca do Pod de alagamento |
| HPA por CPU | Cada uma das tres APIs passou automaticamente de uma para duas replicas prontas sob carga |
| Balanceamento | Logs do Traefik registraram pelo menos dois enderecos de backend por API durante a carga |
| Reducao automatica | Os tres HPAs retornaram a uma replica pronta depois da carga |

Na carga pelo Ingress, com 64 requisicoes simultaneas por API:

| API | Respostas 2xx | Falhas | Duracao | Media de requisicoes/s |
|---|---:|---:|---:|---:|
| Alagamento | 49.029 | 0 | 91,45 s | 536,10 |
| Qualidade do ar | 33.426 | 0 | 63,56 s | 525,91 |
| Transito | 30.138 | 0 | 58,44 s | 515,74 |
| Total | **112.593** | **0** | Cargas sequenciais | - |

Esses numeros descrevem esta execucao local. O teste de carga consultou `GET /get/sensores`; nao representa capacidade garantida para outros computadores ou para gravacoes concorrentes. O limite configurado do HPA e de tres replicas; a escala observada e validada foi de uma para duas.

O [registro JSON](evidencias-etapa3.json) inclui as fases, os UIDs usados na verificacao de persistencia, as respostas das probes e as amostras de escala. Credenciais e conteudo de Secrets ficaram fora do registro e do Git.

## Ajustes feitos durante os testes

- O primeiro ensaio de RollingUpdate apresentou quatro respostas 404 durante a troca do backend. Foram acrescentados `minReadySeconds: 5` e `preStop` de cinco segundos nas tres APIs. A suite Kubernetes foi executada novamente por completo e passou, incluindo as 204 requisicoes sem falha durante a atualizacao.
- Os Dockerfiles passaram a copiar os arquivos com o proprietario `node` e executar o build com esse usuario. Isso eliminou o `chown -R` de `node_modules`, que atrasava a construcao das imagens no Docker Desktop.
- O script de build passou a conferir o engine com `docker version`, evitando o bloqueio observado em `docker info` na inicializacao local.

O codigo TypeScript das APIs, contratos, schema, migrations, simuladores Python, testes existentes, dependencias e Compose foram preservados nesta etapa.

## Auditoria de dependencias

`npm audit --omit=dev` apontou tres entradas de severidade alta na cadeia `prisma` / `@prisma/config` / `deepmerge-ts`. Elas correspondem ao aviso [GHSA-ggr8-5vv4-36mx](https://github.com/advisories/GHSA-ggr8-5vv4-36mx), referente a recursao em objetos ciclicos no `deepmerge-ts` anterior a 8.0.0.

A versao instalada do Prisma e 6.19.3. O npm sugeriu Prisma 7.10.1 como correcao, uma atualizacao de versao principal. Essa migracao permanece pendente de revisao; as dependencias nao foram alteradas automaticamente nesta entrega. Os testes funcionais aprovados nao eliminam esse alerta.

## Repetir a verificacao

Siga a preparacao do [guia Kubernetes](kubernetes.md), com Docker Desktop e cluster ligados. Na raiz do projeto:

```powershell
kubectl config use-context docker-desktop
kubectl get nodes
node scripts/k8s/testar.mjs
```

O script recria o Pod do banco, interrompe e restaura o banco, atualiza um Deployment e gera carga. Execute em ambiente de demonstracao ou testes. O novo resultado fica em `evidencias/kubernetes.local.json`; a disponibilidade das APIs depende de o cluster estar ligado.
