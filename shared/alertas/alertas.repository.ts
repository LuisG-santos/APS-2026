import type { DominioAlerta, PrismaClient } from '@prisma/client'

export type EventoAlerta = {
  dominio: DominioAlerta
  leituraId: number
  sensorId: number
  valor: number
  timestamp: Date
}

export function createAlertasRepository(prisma: PrismaClient) {
  return {
    listar(dominio: DominioAlerta) {
      return prisma.alerta.findMany({ where: { dominio }, orderBy: [{ timestamp: 'desc' }, { id: 'desc' }] })
    },
    buscarPendentes() {
      return prisma.tarefaAlerta.findMany({ orderBy: { id: 'asc' }, take: 100 })
    },
    async removerPendente(id: number) {
      await prisma.tarefaAlerta.delete({ where: { id } })
    },
    salvar(evento: EventoAlerta, limite: number) {
      return prisma.alerta.upsert({
        where: { dominio_leituraId: { dominio: evento.dominio, leituraId: evento.leituraId } },
        create: { ...evento, limite },
        update: {}
      })
    },
    async verificarConexao() { await prisma.$queryRaw`SELECT 1` }
  }
}

export type AlertasRepository = ReturnType<typeof createAlertasRepository>
