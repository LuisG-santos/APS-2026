import { Prisma, type PrismaClient } from '@prisma/client'
import type { SensorQualidadeArBody } from '../contracts.js'
import { ErroQualidadeAr } from '../errors.js'

export function createSensoresRepository(prisma: PrismaClient) {
  return {
    listar() {
      return prisma.sensorQualidadeAr.findMany()
    },
    buscarPorId(id: number) {
      return prisma.sensorQualidadeAr.findUnique({ where: { id } })
    },
    async criar(sensor: SensorQualidadeArBody) {
      const data: Prisma.SensorQualidadeArCreateInput = sensor
      try {
        return await prisma.sensorQualidadeAr.create({ data })
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw new ErroQualidadeAr('NOME_DUPLICADO', 'ja existe um sensor com esse nome')
        }
        throw error
      }
    }
  }
}

export type SensoresRepository = ReturnType<typeof createSensoresRepository>
