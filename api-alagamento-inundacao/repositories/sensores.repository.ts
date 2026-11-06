import { consultarSensoresComCache, semCache, type Cache } from '../../shared/cache.js'
import { Prisma, type PrismaClient } from '@prisma/client'
import type { SensorAlagamentoBody } from '../contracts.js'
import { ErroAlagamento } from '../errors.js'

export function createSensoresRepository(prisma: PrismaClient, cache: Cache = semCache) {
  const chave = 'aps:alagamento:sensores:v1'
  return {
    listar() {
      return consultarSensoresComCache(cache, chave, () => prisma.sensorAlagamento.findMany())
    },
    buscarPorId(id: number) {
      return prisma.sensorAlagamento.findUnique({ where: { id } })
    },
    async criar(sensor: SensorAlagamentoBody) {
      const data: Prisma.SensorAlagamentoCreateInput = sensor
      try {
        const cadastrado = await prisma.sensorAlagamento.create({ data })
        await cache.invalidar(chave)
        return cadastrado
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
