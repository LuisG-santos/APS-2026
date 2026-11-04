import type { Prisma, PrismaClient } from '@prisma/client'
import type { MedidaTransito } from '../contracts.js'

type NovaLeitura = { sensorId: number; timestamp: Date } & MedidaTransito

export function createLeiturasRepository(prisma: PrismaClient) {
  return {
    listar() {
      return prisma.transito.findMany({ include: { sensor: true } })
    },
    criar(data: NovaLeitura) {
      const registro: Prisma.TransitoUncheckedCreateInput = data
      return prisma.transito.create({ data: registro, include: { sensor: true } })
    },
    async verificarConexao(): Promise<void> {
      await prisma.$queryRaw`SELECT 1`
    }
  }
}

export type LeiturasRepository = ReturnType<typeof createLeiturasRepository>
