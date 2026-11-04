import type { TipoSensorQualidadeAr } from '@prisma/client'
import { isFiniteNumber, parseSensorTimestamp } from '../../shared/validation.js'
import type { QualidadeArBody, MedidaQualidadeAr } from '../contracts.js'
import { ErroQualidadeAr } from '../errors.js'
import type { LeiturasRepository } from '../repositories/leituras.repository.js'
import type { SensoresRepository } from '../repositories/sensores.repository.js'

function medidaParaSensor(body: QualidadeArBody, tipo: TipoSensorQualidadeAr): MedidaQualidadeAr | null {
  switch (tipo) {
    case 'MP25':
      return isFiniteNumber(body.mp25) ? { mp25: body.mp25 } : null
    case 'CO':
      return isFiniteNumber(body.co) ? { co: body.co } : null
    case 'NO2':
      return isFiniteNumber(body.no2) ? { no2: body.no2 } : null
    case 'TEMPERATURA':
      return isFiniteNumber(body.temperatura) ? { temperatura: body.temperatura } : null
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
    async registrar(body: QualidadeArBody) {
      const timestamp = parseSensorTimestamp(body.timestamp)
      if (!timestamp) {
        throw new ErroQualidadeAr('TIMESTAMP_INVALIDO', 'timestamp deve ser uma data ISO 8601 valida com fuso horario')
      }
      const sensor = await sensores.buscarPorId(body.sensorId)
      if (!sensor) {
        throw new ErroQualidadeAr('SENSOR_NAO_ENCONTRADO', 'sensor nao encontrado')
      }
      const medida = medidaParaSensor(body, sensor.tipo)
      if (!medida) {
        throw new ErroQualidadeAr('MEDIDA_INCOMPATIVEL', `medida incompativel com o sensor ${sensor.tipo}`)
      }
      return leituras.criar({ sensorId: body.sensorId, timestamp, ...medida })
    }
  }
}

export type LeiturasService = ReturnType<typeof createLeiturasService>
