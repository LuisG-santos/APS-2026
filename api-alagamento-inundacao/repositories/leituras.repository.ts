import type { Prisma, PrismaClient } from '@prisma/client'
import type { MedidaAlagamento } from '../contracts.js'

type NovaLeitura = { sensorId: number; timestamp: Date } & MedidaAlagamento

export function createLeiturasRepository(prisma: PrismaClient) {
  return {
    listar() {
      return prisma.alagamento.findMany({ include: { sensor: true } })
    },
    criar(data: NovaLeitura) {
      const registro: Prisma.AlagamentoUncheckedCreateInput = data
      return prisma.alagamento.create({ data: registro, include: { sensor: true } })
    },
    async verificarConexao(): Promise<void> {
      await prisma.$queryRaw`SELECT 1`
    }
  }
}

export type LeiturasRepository = ReturnType<typeof createLeiturasRepository>
