# Testes de carga e gráficos das APIs

O coletor envia POSTs de leituras ou GETs de consulta para uma API ou para as três simultaneamente pelo Ingress. Usa os mesmos dez tipos dos simuladores, mas cadastra sensores próprios uma única vez antes da medição. Os req.py continuam sendo os simuladores simples.

O teste não altera Deployments, réplicas, schema ou credenciais. Nos perfis curto e progressivo o HPA pode reagir à carga. O perfil base exige HPA removido e uma réplica em cada uma das três APIs; verifica essa condição, mas não muda o cluster. Sensores e leituras criados permanecem no banco, identificados por um nome começando com carga- e o ID da execução; não há limpeza automática.

## Preparação

Use Python 3.9 ou superior, kubectl e o cluster funcionando. A partir da raiz:

~~~sh
python3 -m venv .venv-desempenho
source .venv-desempenho/bin/activate
python -m pip install -r scripts/desempenho/requirements.txt
kubectl --context docker-desktop get pods,hpa -n aps
~~~

No Windows PowerShell, crie o ambiente com python e ative com:

~~~powershell
.\.venv-desempenho\Scripts\Activate.ps1
~~~

O gerador usa a biblioteca padrão para HTTP, conexões reutilizadas por trabalhador, threads e CSV. NumPy calcula percentis; Matplotlib gera imagens sem exigir uma janela gráfica. O pip seleciona versões compatíveis com o Python: na validação com Python 3.9, foram utilizadas NumPy 2.0.2 e Matplotlib 3.9.4.

Antes de cadastrar sensores, o coletor verifica a readiness e consulta Deployments e HPAs. A ausência de HPA é aceita; na base, ela é obrigatória nas três APIs. Se a preparação falhar, não inicia a carga. O banco e as APIs precisam estar disponíveis; mantenha também a fila e o worker funcionando para processar as tarefas normalmente. Todos os acessos kubectl são consultas, com contexto explícito.

As três APIs passaram a devolver X-Pod (POD_NAME ou hostname) e X-Versao (APP_VERSION ou nao-informada). É necessário reconstruir e atualizar suas imagens antes de medir a distribuição real. No Kubernetes, o hostname padrão identifica o pod; fora dele, identifica a máquina/container. Não interprete um hostname local como pod do cluster. Não foi necessário alterar schema ou manifestos para esses cabeçalhos.

O endereço padrão é http://localhost:30080. Se precisar usar encaminhamento de porta, mantenha em outro terminal:

~~~sh
kubectl --context docker-desktop port-forward -n aps service/aps-gateway 8080:80
~~~

Nesse caso, passe --base-url http://localhost:8080 ao coletor. O script não abre o encaminhamento automaticamente nem muda seu contexto global do kubectl.

## Primeiro teste

Com o ambiente virtual ativado:

~~~sh
python scripts/desempenho/carga.py
~~~

O padrão é o perfil curto: **30 segundos e concorrência 2 por API**, nas três juntas. São até seis envios simultâneos. Cada trabalhador aguarda a resposta e envia a próxima leitura; não é uma taxa fixa de seis requisições por segundo.

O cadastro dos dez sensores e as consultas de preparação não entram na medição. Cada API alterna seus tipos: três em alagamento, quatro em qualidade do ar e três em trânsito. Uma leitura contém sensorId, timestamp UTC e somente a medida correspondente ao tipo.

As medidas variam por requisição, respeitando as unidades documentadas e uma medida por leitura, sem forçar alertas acima dos limites padrão. Cada trabalhador tem seu próprio gerador aleatório; --semente controla as sequências, não a ordem global de threads. Os quatro sensores de qualidade do ar são distribuídos entre três estações da execução (--estacoes aceita 1 a 4); estação é atributo do cadastro, não da leitura. Mesmo valores abaixo do limite geram tarefas nos três tipos com regra. O teste não mede o tempo do worker nem espera os alertas terminarem.

O terminal informa a pasta criada, por exemplo:

~~~text
evidencias/desempenho/20261111T120000Z-abc12345
~~~

Esse nome é ilustrativo. Use o caminho que aparecer na sua execução para gerar os gráficos:

~~~sh
python scripts/desempenho/graficos.py evidencias/desempenho/ID_DA_EXECUCAO
~~~

Essa etapa somente lê os resultados; pode ser repetida sem enviar novas requisições.

## Opções de carga

~~~sh
python scripts/desempenho/carga.py --api alagamento --duracao 60 --concorrencia 4
python scripts/desempenho/carga.py --api qualidade-ar
python scripts/desempenho/carga.py --api transito
python scripts/desempenho/carga.py --base-url http://localhost:8080
python scripts/desempenho/carga.py --contexto docker-desktop --namespace aps
python scripts/desempenho/carga.py --api alagamento -c 8 -d 20 --exigir-pod
python scripts/desempenho/carga.py --api alagamento --metodo GET -c 8 -d 20
~~~

--api aceita todas, alagamento, qualidade-ar ou transito. -c equivale a --concorrencia e -d a --duracao. --concorrencia ajusta o perfil curto; --duracao ajusta o curto ou a duração de cada degrau da base. --timeout é o timeout de conexão/leitura, padrão 10 segundos; não é uma garantia de prazo total para uma resposta que envie dados continuamente. --saida escolhe uma pasta nova e não sobrescreve resultados existentes. Por exigência da ficha, o alvo deve ser localhost, 127.0.0.1 ou ::1; use port-forward para um cluster remoto.

No modo GET, a rota padrão é /<api>/get/sensores, com resposta 200 e lista de sensores válidos. Ela usa o cadastro e o cache, sem crescer a cada leitura de ingestão. Cadastros e verificações continuam fora do cronômetro. Para medir outra consulta JSON existente, selecione uma API e use, por exemplo, --metodo GET --rota /alagamento/get/alertas. A rota personalizada passa por uma verificação inicial e exige JSON objeto/lista e HTTP 200; seu contrato específico deve ser verificado separadamente. Não inclua consultas que retornem todo o histórico crescente na comparação de capacidade.

As APIs atuais não possuem consulta agregada de leituras. O GET de sensores permite medir uma consulta real com cache, mas não substitui a rota agregada mencionada no Anexo A. O gerador aceita essa rota por --rota quando ela existir; criar agregações nas APIs não faz parte desta alteração.

Para observar uma carga crescente, execute separadamente:

~~~sh
python scripts/desempenho/carga.py --perfil progressivo
~~~

| Etapa | Duração | Concorrência por API | Total nas três |
| --- | --- | --- | --- |
| Carga inicial | 120 s | 2 | 6 |
| Carga intermediária | 120 s | 8 | 24 |
| Carga maior | 120 s | 16 | 48 |
| Recuperação | 180 s | 0 novos envios | 0 novos envios |

O perfil dura nove minutos, mais preparação e eventual finalização das respostas. Durante a recuperação, respostas já em trânsito podem terminar e o Kubernetes continua sendo consultado. Não combine --perfil progressivo com os ajustes --duracao e --concorrencia.

O perfil curto valida a ferramenta e não comprova capacidade máxima nem crescimento do HPA. O progressivo pode aumentar o volume persistido e não garante crescimento das réplicas: isso depende das métricas, políticas, gargalos e capacidade do nó. Ele não é executado automaticamente após o curto.

## Arquivos e medição

Cada execução cria uma pasta exclusiva com:

| Arquivo | Conteúdo |
| --- | --- |
| execucao.json | ID, configuração, etapas, sensores cadastrados, horários e estado final. |
| http.csv | Uma linha por tentativa de POST ou GET, inclusive erros. |
| kubernetes.csv | Amostras por API, aproximadamente a cada 5 segundos. |
| recursos.csv | CPU em milicores e memória em MiB por pod/container, incluindo banco, gateway, fila/cache e worker; lacunas explícitas. |
| serie-segundos.csv | Uma linha por segundo e por API, horário UTC, trabalhadores, volume, erros, percentis e pods distintos. Criado ao finalizar, inclusive em Ctrl+C. |
| degraus.csv | Resultado por API, degrau e repetição; aquecimento e respostas que cruzam degraus excluídos. |
| analise.md | Tabela medida e campos para concluir saturação, gargalo e variação. Anotações do grupo são preservadas ao regenerar. |
| resumo.json | Totais, percentis gerais, erros e resultados por janela. |
| janelas.csv | Agregação temporal, criada ao gerar os gráficos. |
| alagamento.png, qualidade-ar.png, transito.png | Quatro painéis por API selecionada. |
| *-por-carga.png | Latência e vazão por trabalhadores, com uma linha por repetição e possíveis regiões de degradação. |
| relatorio.pdf | Painéis temporais e gráficos por carga das APIs selecionadas. |

O tempo HTTP usa relógio monotônico: começa antes do envio e termina após ler o corpo completo. Inclui conexão quando necessária, rede, gateway e API; não mede somente o banco. Não inclui escrita no CSV nem validação do JSON.

No POST, sucesso exige HTTP 201, ID válido, sensor associado correto, timestamp preservado, createdAt com fuso, medida correspondente e outras medidas null. O CSV guarda também método, rota, trabalhador, concorrência, repetição, aquecimento, X-Pod e X-Versao. Cabeçalhos ausentes ficam vazios; não são deduzidos das réplicas. O resumo conta respostas por pod e código HTTP e avisa sobre X-Pod ausente. --exigir-pod bloqueia a preparação sem o cabeçalho; na base, essa opção é obrigatória automaticamente. Não salva corpos completos de respostas ou credenciais.

Falhas HTTP, resposta inválida, conexão e timeout ficam separadas. Não há repetição automática de POST: após timeout, o servidor pode ter persistido uma leitura mesmo sem o cliente receber confirmação.

Kubernetes é consultado com get para Deployments, HPAs e capacidade dos nós, e top pods --containers para CPU/memória. O CSV de réplicas inclui os limites configurados do container principal. Erros deixam campos vazios e descrição de falha, sem substituir dados ausentes por zero. Métricas top têm atraso e resolução próprios do metrics-server; não são medições instantâneas de cada requisição. A duração observada inclui o encerramento da coleta, mas a vazão geral não é diluída pelo tempo extra de finalizar kubectl.

## Como ler os gráficos

1. **Latência:** P50, P95 e P99 das respostas válidas (POST 201 / GET 200), calculados com NumPy e interpolação linear. P95 de 80 ms significa que aproximadamente 95% dessas respostas terminaram em até 80 ms.
2. **Requisições por segundo:** conclusões no intervalo, separando sucessos de falhas.
3. **Taxa de erros:** falhas divididas por tentativas concluídas no intervalo, em porcentagem.
4. **Réplicas:** quantidade desejada e pronta, com lacunas quando a coleta falhou.

As janelas padrão são de 10 segundos, pelo instante de conclusão da requisição; a última janela pode ser menor e sua taxa usa a duração real. Para alterar:

~~~sh
python scripts/desempenho/graficos.py evidencias/desempenho/ID_DA_EXECUCAO --janela 5
~~~

Sem sucessos, a janela fica sem percentis. Sem requisições, a taxa de erros é indefinida e fica sem ponto; o volume de conclusões é zero. Janelas com menos de 100 sucessos têm P99 marcado como amostra pequena. As quantidades estão no gráfico, nas janelas do JSON e no janelas.csv; P99 pode ser pouco estável mesmo acima desse mínimo.

Percentis gerais são recalculados com todas as respostas válidas da API, nunca pela média dos percentis das janelas. A taxa geral considera o período observado de carga e as respostas em trânsito, excluindo a recuperação sem novos envios. Já os painéis mostram todo o período, incluindo a recuperação.

O fundo destacado no perfil progressivo indica recuperação; linhas verticais separam etapas de carga. Comparar execuções exige considerar concorrência, duração, dados existentes, réplicas iniciais, computador e caminho de rede. Como o gerador e o cluster podem dividir a mesma máquina, o próprio gerador também pode limitar a carga obtida.

O terminal mostra aproximadamente a cada segundo o horário UTC, trabalhadores habilitados no momento, OK/s no intervalo, erros, P50/P95 e pods distintos. As linhas do terminal são progresso aproximado; a série salva é recalculada dos horários de conclusão em intervalos [início, fim), com última janela parcial. Na recuperação/finalização há zero novos envios, mas respostas em andamento podem terminar.

O horário UTC de cada segundo é calibrado pelos primeiros inícios HTTP daquele intervalo, usando a mediana de até nove referências. Isso acompanha ajustes do relógio do sistema sem alterar duração/latência monotônicas. fonte_hora_utc identifica referências reais e intervalos com horário estimado por falta de novos envios; desvio_relogio_s mostra o deslocamento da referência inicial.

## Linha de base da Etapa 4

O objetivo é medir a capacidade com **uma réplica de cada API e HPA removido**, antes de comparar com escala. As execuções curtas antigas com duas réplicas não são linha de base. O perfil progressivo com HPA também não substitui esse experimento.

Primeiro, reconstrua e atualize as imagens das APIs com a identificação X-Pod. Use o procedimento de atualização de imagens do [guia Kubernetes](kubernetes.md), com uma nova tag fixa; reiniciar pods que usam a imagem antiga não acrescenta o cabeçalho. Este coletor não constrói imagens nem aplica recursos.

Prepare o cluster manualmente, em um momento reservado ao experimento. Os comandos abaixo mudam apenas HPA/réplicas, sem excluir banco ou volumes:

~~~sh
kubectl --context docker-desktop get deploy,hpa -n aps
kubectl --context docker-desktop delete hpa api-alagamento api-qualidade-ar api-transito -n aps --ignore-not-found
kubectl --context docker-desktop scale deployment api-alagamento api-qualidade-ar api-transito -n aps --replicas=1
kubectl --context docker-desktop rollout status deployment/api-alagamento -n aps
kubectl --context docker-desktop rollout status deployment/api-qualidade-ar -n aps
kubectl --context docker-desktop rollout status deployment/api-transito -n aps
kubectl --context docker-desktop get deploy,hpa -n aps
curl -i http://localhost:30080/alagamento/health/live
~~~

A última resposta deve conter X-Pod. Repita a conferência em /qualidade-ar/health/live e /transito/health/live. HPA removido é diferente de apenas reduzir minReplicas: se ele continuar ativo, pode interferir na medição.

Depois, meça uma API por vez para facilitar a atribuição do gargalo:

~~~sh
python scripts/desempenho/carga.py --api alagamento --perfil base
python scripts/desempenho/carga.py --api qualidade-ar --perfil base
python scripts/desempenho/carga.py --api transito --perfil base
~~~

Cada comando executa 1, 2, 4, 8, 16, 32 e 64 trabalhadores; 25 segundos por degrau, com os primeiros 5 segundos descartados, repetindo a sequência três vezes. São 8min45s de carga por comando, mais preparação e encerramento. As outras duas APIs também precisam permanecer com uma réplica e sem HPA. Se essa condição mudar durante a coleta, o script interrompe e marca base_invalidada. Nenhum HPA é removido automaticamente.

Para ajustar o experimento:

~~~sh
python scripts/desempenho/carga.py --api alagamento --perfil base --degraus 1,2,4,8,16,32,64 -d 30 --aquecimento 5 --repeticoes 3
python scripts/desempenho/carga.py --api alagamento --metodo GET --perfil base
~~~

O modo padrão todas continua disponível e aplica a concorrência **por API**: no degrau 64, as três juntas têm até 192 envios simultâneos. Isso mede a competição pelo banco e pela máquina compartilhados; não equivale à capacidade isolada de uma API.

Registre as condições com --cpu-cluster, --ram-cluster-gb, --nos e --observacoes, usando os valores reais. A capacidade dos nós, o sistema/Python e os núcleos lógicos do gerador são coletados automaticamente quando disponíveis. No Docker Desktop, a capacidade do nó representa a VM, não necessariamente todo o notebook. Use --gerador-fora-cluster se o gerador estiver em outra máquina física; não passe essa opção apenas por executá-lo fora de um pod.

**Como o aquecimento é descartado:** todas as tentativas ficam em http.csv. Para a tabela da base, só entram requisições iniciadas depois do aquecimento e concluídas até o fim do mesmo degrau. Aquelas que cruzam a fronteira ficam no bruto e na série temporal, mas não contaminam o degrau seguinte. Os campos aquecimento e valida_para_degrau tornam o descarte verificável. No resumo da base, total_bruto inclui tudo; total, sucessos, falhas, taxas e percentis usam a amostra medida. Os painéis temporais mantêm os dados brutos, com aquecimentos em cinza.

Ao terminar, gere e preserve as evidências:

~~~sh
python scripts/desempenho/graficos.py evidencias/desempenho/ID_DA_EXECUCAO --publicar evidencias/base/ID_DA_EXECUCAO
~~~

Isso gera os gráficos e copia CSVs brutos, resumo, configuração/comando, PNGs, PDF e analise.md para uma pasta nova. HTTP CSV com 20 MiB ou mais é publicado como http.csv.gz, preservando todas as linhas; o gerador de gráficos também lê esse formato diretamente. O CSV original permanece na execução local. evidencias/desempenho é ignorada pelo Git; **evidencias/base não é ignorada** e serve para entregar os resultados escolhidos. Revise o volume dos CSVs antes de adicioná-los. Não publique dados simulados como evidência do cluster. A publicação recusa uma pasta existente e copia apenas os artefatos conhecidos, sem arquivos de ambiente. Regenerar não altera CSVs brutos nem apaga conclusões já escritas em analise.md.

O gráfico *-por-carga.png mostra P50/P95/P99 e OK/s por trabalhadores, com cada repetição separada. O JSON lista candidatos a degradação quando há erros ou quando, em relação ao degrau anterior, a vazão cresce no máximo 10% e o P95 sobe ao menos 50%, com pelo menos 100 amostras nos dois degraus. Esses critérios são heurísticos e declarados, não exigências numéricas do professor. O sombreado marca apenas um possível problema: não atribui sua causa e não comprova capacidade máxima.

Para concluir a ficha, examine degraus.csv, recursos.csv, kubernetes.csv e analise.md:

- Compare as três repetições; informe sua variação, sem escolher somente a melhor execução.
- Procure o ponto em que a vazão para de crescer e o P95 piora, ou surgem erros.
- Compare CPU dos pods com os limites configurados. CPU perto do limite é indício; throttling exige evidência adicional se for a causa alegada.
- Observe banco, gateway, fila/cache e worker. O top registra seus recursos, mas tamanho da fila, acerto do cache, conexões do banco e throttling precisam de inspeção própria.
- Observe também o Monitor de Atividade/top do computador. O gerador, a escrita de CSV, o gateway e o cluster podem competir pela mesma CPU e disco. Em regime estável e sem erros, confira aproximadamente trabalhadores = OK/s × latência média em segundos; há também tempo de validação/escrita no ciclo do trabalhador.
- Preencha a conclusão com valores medidos: “Uma réplica suporta ___ OK/s com P95 ___ ms; a degradação aparece em ___ trabalhadores; a evidência do gargalo é ___”. Se não saturar até 64, registre isso em vez de inventar um ponto.

Depois do experimento, restaure a configuração de HPA dos manifestos:

~~~sh
kubectl --context docker-desktop apply -f k8s/09-autoscaling.yaml
kubectl --context docker-desktop get deploy,hpa -n aps
~~~

Isso restaura a política do manifesto, que tem mínimo de duas réplicas; não é uma restauração de qualquer estado manual anterior.

Para a demonstração ao vivo de 20 segundos com oito trabalhadores:

~~~sh
python scripts/desempenho/carga.py --api alagamento -c 8 -d 20 --exigir-pod
~~~

Com duas réplicas, mostre por_pod no resumo e a coluna pod do CSV. Números de réplicas não provam distribuição: os cabeçalhos precisam mostrar as instâncias que responderam. Para localizar a maior latência, ordene duracao_ms numericamente no CSV. Explique P95 sempre junto de taxa de erros e tamanho da amostra.

## Interrupção e testes

Ctrl+C interrompe novos envios, aguarda a finalização das tentativas em trânsito e salva o que foi coletado. É possível gerar gráficos dessa execução parcial. Códigos de saída: 0 para execução concluída sem falhas observadas; 1 para erro HTTP, de preparação/coleta ou base invalidada; 130 para interrupção. Não há um limite de latência de aprovação implícito.

Para verificar sem acessar o cluster:

~~~sh
python -m unittest discover -s tests -p 'test_desempenho.py' -v
~~~

A suíte usa servidor HTTP local e snapshots Kubernetes simulados em pastas temporárias. Cobre contratos dos dez tipos, variação de valores/estações, sensores isolados, percentis conhecidos, fronteiras de janelas/degraus, aquecimento, erros, timeout, interrupção, GET, cabeçalhos, base sem HPA, mudança de réplicas, CPU/memória e lacunas, publicação e geração de PNG/PDF. Resultados simulados não são evidência de desempenho real. O teste HTTP de identificação das três APIs fica em tests/identificacao.test.mjs, incluído na suíte npm principal.

O ambiente virtual e as pastas de resultados são ignorados pelo Git. As APIs, os simuladores e o gerador GET antigo permanecem independentes deste teste.

## Validação real em 11 de novembro de 2026

Depois de iniciar o Docker Desktop, foi executado o perfil curto no cluster local, pelo gateway na porta 30080: três APIs simultâneas, concorrência 2 por API, 30 segundos de novos envios e aproximadamente 30,05 segundos observados até finalizar a coleta.

| API | Leituras confirmadas | Falhas | P50 | P95 | P99 |
| --- | --- | --- | --- | --- | --- |
| Alagamento | 15.733 | 0 | 2,62 ms | 14,52 ms | 23,27 ms |
| Qualidade do ar | 15.816 | 0 | 2,59 ms | 14,28 ms | 23,46 ms |
| Trânsito | 15.534 | 0 | 2,64 ms | 14,77 ms | 23,49 ms |
| Total | **47.083** | **0** | — | — | — |

Execução identificada por 20261111T190336Z-ba00d4f7. Foram registradas sete amostras Kubernetes por API, sem lacunas; todas mantiveram duas réplicas desejadas e prontas durante a observação. Os dez sensores e as leituras permanecem no banco. Estes resultados não comprovam aumento do HPA nem capacidade máxima.

As respostas em trânsito terminaram logo após 30 segundos. Por isso há uma última janela parcial, com apenas duas respostas por API. O gráfico informa sua duração, marca a amostra pequena e o fim dos novos envios. A queda do volume nessa fração final não deve ser interpretada como queda de capacidade.

## Campanha real da Etapa 4 em 13 de novembro de 2026

As APIs foram atualizadas para etapa4-v1. Foi validada a distribuição entre dois pods, seguida da linha de base POST nas três APIs e GET de sensores de alagamento: sete níveis, três repetições e descarte de cinco segundos. Os HPAs e as duas réplicas por API foram restaurados ao final. A sobrecarga produziu falhas reais no gateway; a recuperação afetou o começo de uma rodada. Esses efeitos e as limitações da comparação estão registrados, junto dos dados brutos e da evidência de CPU, no [relatório da campanha](../evidencias/base/etapa4-20261113T134526Z/README.md).
