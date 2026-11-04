import { Prisma, type PrismaClient } from '@prisma/client'
import type { SensorAlagamentoBody } from '../contracts.js'
import { ErroAlagamento } from '../errors.js'

export function createSensoresRepository(prisma: PrismaClient) {
  return {
    listar() {
      return prisma.sensorAlagamento.findMany()
    },
    buscarPorId(id: number) {
      return prisma.sensorAlagamento.findUnique({ where: { id } })
    },
    async criar(sensor: SensorAlagamentoBody) {
      const data: Prisma.SensorAlagamentoCreateInput = sensor
      try {
        return await prisma.sensorAlagamento.create({ data })
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw new ErroAlagamento('NOME_DUPLICADO', 'ja existe um sensor com esse nome')
        }
        throw error
      }
    }
  }
}

export type SensoresRepository = ReturnType<typeof createSensoresRepository>
