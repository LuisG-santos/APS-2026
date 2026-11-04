import { Prisma, type PrismaClient } from '@prisma/client'
import { ErroAplicacao } from '../../shared/errors.js'
import type { SensorBody } from '../contracts.js'

export function createSensoresRepository(prisma: PrismaClient) {
  return {
    listar() {
      return prisma.sensorTransito.findMany()
    },
    buscarPorId(id: number) {
      return prisma.sensorTransito.findUnique({ where: { id } })
    },
    async criar(data: SensorBody) {
      try {
        return await prisma.sensorTransito.create({ data })
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw new ErroAplicacao('NOME_DUPLICADO', 'ja existe um sensor com esse nome')
        }
        throw error
      }
    }
  }
}

export type SensoresRepository = ReturnType<typeof createSensoresRepository>
