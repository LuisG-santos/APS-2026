import { connect } from 'amqplib'
import type { ConsumeMessage } from 'amqplib'
import { setTimeout as aguardar } from 'node:timers/promises'
import { lerEvento } from './alertas.service.js'
import type { EventoAlerta } from './alertas.repository.js'

export const NOME_FILA = 'aps.alertas.v1'
export const FILA_INVALIDOS = 'aps.alertas.invalidos.v1'

export async function abrirFila(url: string, processar: (evento: EventoAlerta) => Promise<unknown>) {
  const conexao = await connect(url, { timeout: 3000 })
  let ativa = true, bloqueada = false
  const falha = () => { ativa = false }
  conexao.on('error', falha)
  conexao.on('close', falha)
  conexao.on('blocked', () => { bloqueada = true })
  conexao.on('unblocked', () => { bloqueada = false })

  async function comPrazo<T>(operacao: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([operacao, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          ativa = false
          void conexao.close().catch(() => {})
          reject(new Error('Timeout da fila'))
        }, 5000)
      })])
    } finally { clearTimeout(timer) }
  }

  try {
    const publicador = await comPrazo(conexao.createConfirmChannel())
    const consumidor = await comPrazo(conexao.createChannel())
    publicador.on('error', falha); publicador.on('close', falha)
    consumidor.on('error', falha); consumidor.on('close', falha)
    await comPrazo(publicador.assertQueue(FILA_INVALIDOS, { durable: true }))
    await comPrazo(publicador.assertQueue(NOME_FILA, { durable: true,
      deadLetterExchange: '', deadLetterRoutingKey: FILA_INVALIDOS }))
    await comPrazo(consumidor.prefetch(1))
    let retornada = false
    publicador.on('return', () => { retornada = true })
    const emProcessamento = new Set<Promise<void>>()

    async function tratar(mensagem: ConsumeMessage) {
      let evento: EventoAlerta
      try { evento = lerEvento(mensagem.content.toString('utf8')) } catch {
        consumidor.nack(mensagem, false, false)
        console.error('Evento invalido encaminhado para a fila de invalidos.')
        return
      }
      try {
        const alerta = await processar(evento)
        consumidor.ack(mensagem)
        console.log(JSON.stringify({ evento: 'leitura_processada', dominio: evento.dominio,
          leituraId: evento.leituraId, alerta: alerta !== null }))
      } catch {
        console.error('Falha ao processar alerta; a mensagem sera tentada novamente.')
        await aguardar(1000)
        if (ativa) consumidor.nack(mensagem, false, true)
      }
    }
    const { consumerTag } = await comPrazo(consumidor.consume(NOME_FILA, mensagem => {
      if (!mensagem) { ativa = false; return }
      const tarefa = tratar(mensagem).catch(falha)
      emProcessamento.add(tarefa)
      void tarefa.finally(() => emProcessamento.delete(tarefa))
    }, { noAck: false }))

    return {
      get ativa() { return ativa && !bloqueada },
      async publicar(evento: EventoAlerta) {
        if (!ativa || bloqueada) throw new Error('Fila indisponivel')
        retornada = false
        publicador.sendToQueue(NOME_FILA, Buffer.from(JSON.stringify({ versao: 1, ...evento })), {
          persistent: true, contentType: 'application/json', mandatory: true,
          messageId: `${evento.dominio}:${evento.leituraId}`
        })
        await comPrazo(publicador.waitForConfirms())
        if (retornada) throw new Error('Fila nao recebeu o evento')
      },
      async verificarConexao() {
        if (!ativa || bloqueada) throw new Error('Fila indisponivel')
        await comPrazo(publicador.checkQueue(NOME_FILA))
      },
      async fechar() {
        ativa = false
        try {
          await comPrazo(consumidor.cancel(consumerTag))
          await comPrazo(Promise.all(emProcessamento))
        } catch { /* O fechamento da conexao devolve mensagens sem ACK para a fila. */ }
        await comPrazo(conexao.close()).catch(() => {})
      }
    }
  } catch (error) {
    void conexao.close().catch(() => {})
    throw error
  }
}

export type Fila = Awaited<ReturnType<typeof abrirFila>>
