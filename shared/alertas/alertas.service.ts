import type { DominioAlerta } from '@prisma/client'
import { isRecord, isSensorId, parseSensorTimestamp } from '../validation.js'
import type { AlertasRepository, EventoAlerta } from './alertas.repository.js'

export function carregarLimites(env: Record<string, string | undefined>) {
  function numero(nome: string, padrao: number, maximo = Infinity) {
    const texto = env[nome]
    const valor = texto === undefined ? padrao : Number(texto)
    if (texto?.trim() === '' || !Number.isFinite(valor) || valor < 0 || valor > maximo) {
      throw new Error(`Configuracao invalida: ${nome}`)
    }
    return valor
  }
  return {
    ALAGAMENTO: numero('ALERTA_NIVEL_CORREGO_CM', 150),
    QUALIDADE_AR: numero('ALERTA_MP25', 35),
    TRANSITO: numero('ALERTA_OCUPACAO', 0.80, 1)
  }
}
export type Limites = ReturnType<typeof carregarLimites>

export function lerEvento(json: string): EventoAlerta {
  const valor: unknown = JSON.parse(json)
  if (!isRecord(valor) || valor.versao !== 1 ||
      typeof valor.dominio !== 'string' || !['ALAGAMENTO', 'QUALIDADE_AR', 'TRANSITO'].includes(valor.dominio) ||
      !isSensorId(valor.leituraId) || !isSensorId(valor.sensorId) ||
      typeof valor.valor !== 'number' || !Number.isFinite(valor.valor) || typeof valor.timestamp !== 'string') {
    throw new Error('Evento de alerta invalido')
  }
  const timestamp = parseSensorTimestamp(valor.timestamp)
  if (!timestamp) throw new Error('Timestamp do evento invalido')
  return { dominio: valor.dominio as DominioAlerta, leituraId: valor.leituraId,
    sensorId: valor.sensorId, valor: valor.valor, timestamp }
}

export function createAlertasService(repository: AlertasRepository, limites: Limites = carregarLimites({})) {
  return {
    listar(dominio: DominioAlerta) { return repository.listar(dominio) },
    async processar(evento: EventoAlerta) {
      const limite = limites[evento.dominio]
      return evento.valor > limite ? repository.salvar(evento, limite) : null
    },
    async publicarPendentes(enviar: (evento: EventoAlerta) => Promise<void>) {
      const tarefas = await repository.buscarPendentes()
      for (const tarefa of tarefas) {
        const { dominio, leituraId, sensorId, valor, timestamp } = tarefa
        await enviar({ dominio, leituraId, sensorId, valor, timestamp })
        await repository.removerPendente(tarefa.id)
      }
      return tarefas.length
    }
  }
}
