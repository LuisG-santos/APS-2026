import { TipoSensorAlagamento, type Prisma, type SensorAlagamento } from '@prisma/client'
import type { CreatedJson, ReadingJson } from '../shared/serialization.js'
import { isFiniteNumber, isNonEmptyString, isRecord, isSensorId } from '../shared/validation.js'

export interface SensorBody {
  nome: string
  tipo: TipoSensorAlagamento
}

export type MedidaAlagamento = { nivelCorregoCm: number; chuvaAcumuladaMm?: never; nivelAguaViaCm?: never } |
  { nivelCorregoCm?: never; chuvaAcumuladaMm: number; nivelAguaViaCm?: never } |
  { nivelCorregoCm?: never; chuvaAcumuladaMm?: never; nivelAguaViaCm: number }
export type AlagamentoBody = { sensorId: number; timestamp: string } & MedidaAlagamento
export type SensorResponse = CreatedJson<SensorAlagamento>
export type AlagamentoComSensor = Prisma.AlagamentoGetPayload<{ include: { sensor: true } }>
export type AlagamentoResponse = Omit<ReadingJson<AlagamentoComSensor>, 'sensor'> & { sensor: SensorResponse }

export function isSensorBody(value: unknown): value is SensorBody {
  return isRecord(value) && isNonEmptyString(value.nome) &&
    (value.tipo === TipoSensorAlagamento.NIVEL_CORREGO || value.tipo === TipoSensorAlagamento.PLUVIOMETRO || value.tipo === TipoSensorAlagamento.NIVEL_VIA)
}

export function isAlagamentoBody(value: unknown): value is AlagamentoBody {
  if (!isRecord(value) || !isSensorId(value.sensorId) || typeof value.timestamp !== 'string') return false
  return (
    (isFiniteNumber(value.nivelCorregoCm) && value.chuvaAcumuladaMm === undefined && value.nivelAguaViaCm === undefined) ||
    (value.nivelCorregoCm === undefined && isFiniteNumber(value.chuvaAcumuladaMm) && value.nivelAguaViaCm === undefined) ||
    (value.nivelCorregoCm === undefined && value.chuvaAcumuladaMm === undefined && isFiniteNumber(value.nivelAguaViaCm))
  )
}
