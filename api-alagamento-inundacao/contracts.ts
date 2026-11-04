import { TipoSensorAlagamento, type Prisma, type SensorAlagamento } from '@prisma/client'
import type { CreatedJson, ReadingJson } from '../shared/serialization.js'
import { isFiniteNumber, isNonEmptyString, isRecord, isSensorId } from '../shared/validation.js'

export interface SensorAlagamentoBody {
  nome: string
  tipo: TipoSensorAlagamento
}

export interface NivelMedida {
  nivelCorregoCm: number
  chuvaAcumuladaMm?: never
  nivelAguaViaCm?: never
}

export interface ChuvaMedida {
  nivelCorregoCm?: never
  chuvaAcumuladaMm: number
  nivelAguaViaCm?: never
}

export interface NivelViaMedida {
  nivelCorregoCm?: never
  chuvaAcumuladaMm?: never
  nivelAguaViaCm: number
}

export type MedidaAlagamento = NivelMedida | ChuvaMedida | NivelViaMedida

export type AlagamentoBody = {
  sensorId: number
  timestamp: string
} & MedidaAlagamento

export type SensorAlagamentoResponse = CreatedJson<SensorAlagamento>
export type AlagamentoComSensor = Prisma.AlagamentoGetPayload<{ include: { sensor: true } }>
export type AlagamentoResponse = Omit<ReadingJson<AlagamentoComSensor>, 'sensor'> & {
  sensor: SensorAlagamentoResponse
}

function isTipoSensor(value: unknown): value is TipoSensorAlagamento {
  return value === TipoSensorAlagamento.NIVEL_CORREGO || value === TipoSensorAlagamento.PLUVIOMETRO || value === TipoSensorAlagamento.NIVEL_VIA
}

export function isSensorAlagamentoBody(value: unknown): value is SensorAlagamentoBody {
  return isRecord(value) && isNonEmptyString(value.nome) && isTipoSensor(value.tipo)
}

export function isAlagamentoBody(value: unknown): value is AlagamentoBody {
  if (!isRecord(value) || !isSensorId(value.sensorId) || typeof value.timestamp !== 'string') return false
  return (
    (isFiniteNumber(value.nivelCorregoCm) && value.chuvaAcumuladaMm === undefined && value.nivelAguaViaCm === undefined) ||
    (value.nivelCorregoCm === undefined && isFiniteNumber(value.chuvaAcumuladaMm) && value.nivelAguaViaCm === undefined) ||
    (value.nivelCorregoCm === undefined && value.chuvaAcumuladaMm === undefined && isFiniteNumber(value.nivelAguaViaCm))
  )
}
