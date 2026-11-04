import type { TipoSensorTransito } from '@prisma/client'
import { ErroAplicacao } from '../../shared/errors.js'
import { isFiniteNumber, isNonEmptyString, parseSensorTimestamp } from '../../shared/validation.js'
import type { TransitoBody, MedidaTransito } from '../contracts.js'
import type { LeiturasRepository } from '../repositories/leituras.repository.js'
import type { SensoresRepository } from '../repositories/sensores.repository.js'

function medidaParaSensor(body: TransitoBody, tipo: TipoSensorTransito): MedidaTransito | null {
  switch (tipo) {
    case 'RADAR':
      return isFiniteNumber(body.velocidade) ? { velocidade: body.velocidade } : null
    case 'GPS':
      return isNonEmptyString(body.posicao) ? { posicao: body.posicao } : null
    case 'OCUPACAO':
      return isFiniteNumber(body.ocupacao) ? { ocupacao: body.ocupacao } : null
  }
}

export function createLeiturasService(leituras: LeiturasRepository, sensores: SensoresRepository) {
  return {
    listar() {
      return leituras.listar()
    },
    verificarConexao() {
      return leituras.verificarConexao()
    },
    async registrar(body: TransitoBody) {
      const timestamp = parseSensorTimestamp(body.timestamp)
      if (!timestamp) {
        throw new ErroAplicacao('TIMESTAMP_INVALIDO', 'timestamp deve ser uma data ISO 8601 valida com fuso horario')
      }
      const sensor = await sensores.buscarPorId(body.sensorId)
      if (!sensor) {
        throw new ErroAplicacao('SENSOR_NAO_ENCONTRADO', 'sensor nao encontrado')
      }
      const medida = medidaParaSensor(body, sensor.tipo)
      if (!medida) {
        throw new ErroAplicacao('MEDIDA_INCOMPATIVEL', `medida incompativel com o sensor ${sensor.tipo}`)
      }
      return leituras.criar({ sensorId: body.sensorId, timestamp, ...medida })
    }
  }
}

export type LeiturasService = ReturnType<typeof createLeiturasService>
