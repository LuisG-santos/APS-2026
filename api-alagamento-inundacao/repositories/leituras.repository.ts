import type { Prisma, PrismaClient } from '@prisma/client'
import type { MedidaAlagamento } from '../contracts.js'

type NovaLeitura = { sensorId: number; timestamp: Date } & MedidaAlagamento

export function createLeiturasRepository(prisma: PrismaClient) {
  return {
    listar() {
      return prisma.alagamento.findMany({ include: { sensor: true } })
    },
    criar(leitura: NovaLeitura) {
      const data: Prisma.AlagamentoUncheckedCreateInput = leitura
      const valor = leitura.nivelCorregoCm
      if (valor === undefined) return prisma.alagamento.create({ data, include: { sensor: true } })
      return prisma.$transaction(async tx => {
        const criada = await tx.alagamento.create({ data, include: { sensor: true } })
        await tx.tarefaAlerta.create({ data: { dominio: 'ALAGAMENTO', leituraId: criada.id,
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
