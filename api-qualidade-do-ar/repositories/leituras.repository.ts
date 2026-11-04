import type { Prisma, PrismaClient } from '@prisma/client'
import type { MedidaQualidadeAr } from '../contracts.js'

type NovaLeitura = { sensorId: number; timestamp: Date } & MedidaQualidadeAr

export function createLeiturasRepository(prisma: PrismaClient) {
  return {
    listar() {
      return prisma.qualidadeAr.findMany({ include: { sensor: true } })
    },
    criar(data: NovaLeitura) {
      const registro: Prisma.QualidadeArUncheckedCreateInput = data
      return prisma.qualidadeAr.create({ data: registro, include: { sensor: true } })
    },
    async verificarConexao(): Promise<void> {
      await prisma.$queryRaw`SELECT 1`
    }
  }
}

export type LeiturasRepository = ReturnType<typeof createLeiturasRepository>
