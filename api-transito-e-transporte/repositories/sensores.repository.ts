import { consultarSensoresComCache, semCache, type Cache } from '../../shared/cache.js'
import { Prisma, type PrismaClient } from '@prisma/client'
import type { SensorBody } from '../contracts.js'
import { ErroTransito } from '../errors.js'

export function createSensoresRepository(prisma: PrismaClient, cache: Cache = semCache) {
  const chave = 'aps:transito:sensores:v1'
  return {
    listar() {
      return consultarSensoresComCache(cache, chave, () => prisma.sensorTransito.findMany())
    },
    buscarPorId(id: number) {
      return prisma.sensorTransito.findUnique({ where: { id } })
    },
    async criar(sensor: SensorBody) {
      const data: Prisma.SensorTransitoCreateInput = sensor
      try {
        const cadastrado = await prisma.sensorTransito.create({ data })
        await cache.invalidar(chave)
        return cadastrado
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw new ErroTransito('NOME_DUPLICADO', 'ja existe um sensor com esse nome')
        }
        throw error
      }
    }
  }
}

export type SensoresRepository = ReturnType<typeof createSensoresRepository>
