import { createClient } from 'redis'
import type { CreatedJson } from './serialization.js'

export interface Cache {
  obter(chave: string): Promise<string | null>
  salvar(chave: string, valor: string, segundos: number): Promise<void>
  invalidar(chave: string): Promise<void>
  fechar(): void
}

export const semCache: Cache = {
  obter: async () => null,
  salvar: async () => {},
  invalidar: async () => {},
  fechar: () => {}
}

export function createCacheRedis(url: string | undefined): Cache {
  if (!url?.trim()) return semCache

  const client = createClient({
    url,
    disableOfflineQueue: true,
    socket: { connectTimeout: 1000, reconnectStrategy: () => 1000 }
  })
  let avisado = false
  const avisar = () => {
    if (!avisado) console.warn('Cache Redis indisponivel; as consultas continuam pelo banco.')
    avisado = true
  }
  client.on('error', avisar)
  client.on('ready', () => { avisado = false })
  void client.connect().catch(avisar)

  // O timeout do cliente cobre comandos na fila. Este prazo tambem cobre
  // comandos ja enviados cujo servidor deixou de responder.
  let encerrado = false
  async function executar<T>(operacao: () => Promise<T>): Promise<T> {
    const timer = setTimeout(() => {
      avisar()
      if (client.isOpen) client.destroy()
      if (!encerrado) void client.connect().catch(avisar)
    }, 500)
    try {
      return await operacao()
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    async obter(chave) {
      if (!client.isReady) return null
      try {
        return await executar(() => client.get(chave))
      } catch {
        avisar()
        return null
      }
    },
    async salvar(chave, valor, segundos) {
      if (!client.isReady) return
      try {
        await executar(() => client.set(chave, valor, { EX: segundos }))
      } catch { avisar() }
    },
    async invalidar(chave) {
      if (!client.isReady) return
      try {
        await executar(() => client.del(chave))
      } catch { avisar() }
    },
    fechar() {
      encerrado = true
      if (client.isOpen) client.destroy()
    }
  }
}

// Apenas os cadastros sao armazenados em cache. Os services continuam recebendo Date.
export async function consultarSensoresComCache<T extends { createdAt: Date }>(
  cache: Cache, chave: string, consultar: () => Promise<T[]>
): Promise<T[]> {
  const salvo = await cache.obter(chave)
  if (salvo !== null) {
    try {
      const dados = JSON.parse(salvo) as CreatedJson<T>[]
      if (!Array.isArray(dados)) throw new Error('Lista invalida no cache')
      return dados.map(sensor => {
        if (!sensor || typeof sensor.createdAt !== 'string') throw new Error('Sensor invalido no cache')
        const createdAt = new Date(sensor.createdAt)
        if (!Number.isFinite(createdAt.getTime())) throw new Error('Data invalida no cache')
        return { ...sensor, createdAt } as T
      })
    } catch {
      await cache.invalidar(chave)
    }
  }
  const sensores = await consultar()
  await cache.salvar(chave, JSON.stringify(sensores), 15)
  return sensores
}
