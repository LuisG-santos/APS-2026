import type { Prisma, PrismaClient } from '@prisma/client'
import type { MedidaTransito } from '../contracts.js'

type NovaLeitura = { sensorId: number; timestamp: Date } & MedidaTransito

export function createLeiturasRepository(prisma: PrismaClient) {
  return {
    listar() {
      return prisma.transito.findMany({ include: { sensor: true } })
    },
    criar(leitura: NovaLeitura) {
      const data: Prisma.TransitoUncheckedCreateInput = leitura
      const valor = leitura.ocupacao
      if (valor === undefined) return prisma.transito.create({ data, include: { sensor: true } })
      return prisma.$transaction(async tx => {
        const criada = await tx.transito.create({ data, include: { sensor: true } })
        await tx.tarefaAlerta.create({ data: { dominio: 'TRANSITO', leituraId: criada.id,
          sensorId: criada.sensorId, valor, timestamp: criada.timestamp } })
        return criada
      })
    },
    async verificarConexao(): Promise<void> {
      await prisma.$queryRaw`SELECT 1`
    }
  }
}

export type LeiturasRepository = ReturnType<typeof createLeiturasRepository>
