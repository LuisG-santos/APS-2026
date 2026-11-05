import { setTimeout as aguardar } from 'node:timers/promises'
import { abrirFila, type Fila } from './fila.js'
import { createAlertasService, type Limites } from './alertas.service.js'
import type { AlertasRepository } from './alertas.repository.js'

export function iniciarWorker(repository: AlertasRepository, url: string, limites: Limites) {
  const service = createAlertasService(repository, limites)
  let encerrando = false, fila: Fila | undefined
  const execucao = (async () => {
    while (!encerrando) {
      try {
        fila = await abrirFila(url, evento => service.processar(evento))
        console.log('Worker conectado ao RabbitMQ.')
        while (!encerrando && fila.ativa) {
          const quantidade = await service.publicarPendentes(evento => fila!.publicar(evento))
          if (quantidade === 0) await aguardar(1000)
        }
      } catch {
        console.error('Worker aguardando banco ou fila; nova tentativa em um segundo.')
      } finally {
        await fila?.fechar()
        fila = undefined
      }
      if (!encerrando) await aguardar(1000)
    }
  })()

  return {
    async verificarConexao() {
      if (encerrando || !fila?.ativa) throw new Error('Worker indisponivel')
      await repository.verificarConexao()
      await fila.verificarConexao()
    },
    async fechar() { encerrando = true; await execucao }
  }
}
