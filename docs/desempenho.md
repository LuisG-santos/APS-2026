# Testes de carga e gráficos das APIs

O coletor envia POSTs de leituras para uma API ou para as três simultaneamente pelo Ingress. Usa os mesmos dez tipos dos simuladores, mas cadastra sensores próprios uma única vez antes da medição. Os req.py continuam sendo os simuladores simples.

O teste não altera Deployments, réplicas, schema ou credenciais. O HPA reage normalmente à carga. Sensores e leituras criados permanecem no banco, identificados por um nome começando com carga- e o ID da execução; não há limpeza automática.

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

Antes de cadastrar sensores, o coletor verifica a readiness das APIs e consulta os Deployments e HPAs selecionados. Se essa preparação falhar, não inicia a carga. O banco e as APIs precisam estar disponíveis; mantenha também a fila e o worker funcionando para processar as tarefas normalmente.

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

As medidas são valores de exemplo nas unidades documentadas nos guias de sensores, sem forçar alertas acima dos limites padrão. Mesmo leituras abaixo do limite, nos tipos que têm regra, geram tarefas para o fluxo normal de avaliação. O teste não mede o tempo do worker nem espera os alertas terminarem.

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
~~~

--api aceita todas, alagamento, qualidade-ar ou transito. --duracao e --concorrencia ajustam somente o perfil curto. --timeout é o timeout de conexão/leitura, padrão 10 segundos; não é uma garantia de prazo total para uma resposta que envie dados continuamente. --saida permite escolher uma pasta nova e não sobrescreve resultados existentes.

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
| http.csv | Uma linha por tentativa de POST, inclusive erros. |
| kubernetes.csv | Amostras por API, aproximadamente a cada 5 segundos. |
| resumo.json | Totais, percentis gerais, erros e resultados por janela. |
| janelas.csv | Agregação temporal, criada ao gerar os gráficos. |
| alagamento.png, qualidade-ar.png, transito.png | Quatro painéis por API selecionada. |
| relatorio.pdf | Uma página por API selecionada, com os mesmos painéis. |

O tempo HTTP usa relógio monotônico: começa antes do envio e termina após ler o corpo completo. Inclui conexão quando necessária, rede, gateway e API; não mede somente o banco. Não inclui escrita no CSV nem validação do JSON.

Sucesso exige HTTP 201, ID válido, sensor associado correto, timestamp preservado, createdAt com fuso, medida correspondente e outras medidas null. O CSV guarda status, tipo de sensor, etapa, horários, duração, resultado, categoria de erro e ID da leitura quando disponível. Não salva corpos completos de respostas ou credenciais.

Falhas HTTP, resposta inválida, conexão e timeout ficam separadas. Não há repetição automática de POST: após timeout, o servidor pode ter persistido uma leitura mesmo sem o cliente receber confirmação.

Kubernetes é consultado somente com get para Deployment e HPA. O CSV registra réplicas desejadas, atuais e prontas, além da CPU percentual quando informada pelo HPA. Erros durante a coleta deixam campos vazios e uma descrição de falha, sem substituir dados ausentes por zero. A duração observada inclui a finalização da coleta.

## Como ler os gráficos

1. **Latência:** P50, P95 e P99 das respostas 201 válidas, calculados com NumPy e interpolação linear. P95 de 80 ms significa que aproximadamente 95% dessas respostas terminaram em até 80 ms.
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

## Interrupção e testes

Ctrl+C interrompe novos envios, aguarda a finalização das tentativas em trânsito e salva o que foi coletado. É possível gerar gráficos dessa execução parcial. Códigos de saída: 0 para execução concluída sem falhas observadas; 1 para erro HTTP, de preparação ou coleta; 130 para interrupção. Não há um limite de latência de aprovação implícito.

Para verificar sem acessar o cluster:

~~~sh
python -m unittest discover -s tests -p 'test_desempenho.py' -v
~~~

A suíte usa servidor HTTP local e snapshots Kubernetes simulados em pastas temporárias. Cobre contratos dos dez tipos, sensores isolados, percentis conhecidos, fronteiras de janelas, erros, timeout, interrupção, preparação, lacunas de coleta e geração de PNG/PDF. Resultados simulados não são evidência de desempenho real.

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
