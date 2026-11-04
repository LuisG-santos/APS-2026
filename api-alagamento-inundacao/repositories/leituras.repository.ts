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
      return prisma.alagamento.create({ data, include: { sensor: true } })
    },
    async verificarConexao(): Promise<void> {
      await prisma.$queryRaw`SELECT 1`
    }
  }
}

export type LeiturasRepository = ReturnType<typeof createLeiturasRepository>
