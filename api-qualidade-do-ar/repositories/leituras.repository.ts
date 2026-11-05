import type { Prisma, PrismaClient } from '@prisma/client'
import type { MedidaQualidadeAr } from '../contracts.js'

type NovaLeitura = { sensorId: number; timestamp: Date } & MedidaQualidadeAr

export function createLeiturasRepository(prisma: PrismaClient) {
  return {
    listar() {
      return prisma.qualidadeAr.findMany({ include: { sensor: true } })
    },
    criar(leitura: NovaLeitura) {
      const data: Prisma.QualidadeArUncheckedCreateInput = leitura
      const valor = leitura.mp25
      if (valor === undefined) return prisma.qualidadeAr.create({ data, include: { sensor: true } })
      return prisma.$transaction(async tx => {
        const criada = await tx.qualidadeAr.create({ data, include: { sensor: true } })
        await tx.tarefaAlerta.create({ data: { dominio: 'QUALIDADE_AR', leituraId: criada.id,
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
