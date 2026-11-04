import type { TipoSensorAlagamento } from '@prisma/client'
import { isFiniteNumber, parseSensorTimestamp } from '../../shared/validation.js'
import type { AlagamentoBody, MedidaAlagamento } from '../contracts.js'
import { ErroAlagamento } from '../errors.js'
import type { LeiturasRepository } from '../repositories/leituras.repository.js'
import type { SensoresRepository } from '../repositories/sensores.repository.js'

function medidaParaSensor(body: AlagamentoBody, tipo: TipoSensorAlagamento): MedidaAlagamento | null {
  switch (tipo) {
    case 'NIVEL_CORREGO':
      return isFiniteNumber(body.nivelCorregoCm) ? { nivelCorregoCm: body.nivelCorregoCm } : null
    case 'PLUVIOMETRO':
      return isFiniteNumber(body.chuvaAcumuladaMm) ? { chuvaAcumuladaMm: body.chuvaAcumuladaMm } : null
    case 'NIVEL_VIA':
      return isFiniteNumber(body.nivelAguaViaCm) ? { nivelAguaViaCm: body.nivelAguaViaCm } : null
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
    async registrar(body: AlagamentoBody) {
      const timestamp = parseSensorTimestamp(body.timestamp)
      if (!timestamp) {
        throw new ErroAlagamento('TIMESTAMP_INVALIDO', 'timestamp deve ser uma data ISO 8601 valida com fuso horario')
      }
      const sensor = await sensores.buscarPorId(body.sensorId)
      if (!sensor) {
        throw new ErroAlagamento('SENSOR_NAO_ENCONTRADO', 'sensor nao encontrado')
      }
      const medida = medidaParaSensor(body, sensor.tipo)
      if (!medida) {
        throw new ErroAlagamento('MEDIDA_INCOMPATIVEL', `medida incompativel com o sensor ${sensor.tipo}`)
      }
      return leituras.criar({ sensorId: body.sensorId, timestamp, ...medida })
    }
  }
}

export type LeiturasService = ReturnType<typeof createLeiturasService>
