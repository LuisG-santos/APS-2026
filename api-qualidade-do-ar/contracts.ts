import { TipoSensorQualidadeAr, type Prisma, type SensorQualidadeAr } from '@prisma/client'
import type { CreatedJson, ReadingJson } from '../shared/serialization.js'
import { isFiniteNumber, isNonEmptyString, isRecord, isSensorId } from '../shared/validation.js'

export interface SensorBody {
  nome: string
  tipo: TipoSensorQualidadeAr
  estacao: string
}

export type MedidaQualidadeAr = { mp25: number; co?: never; no2?: never; temperatura?: never } |
  { mp25?: never; co: number; no2?: never; temperatura?: never } |
  { mp25?: never; co?: never; no2: number; temperatura?: never } |
  { mp25?: never; co?: never; no2?: never; temperatura: number }
export type QualidadeArBody = { sensorId: number; timestamp: string } & MedidaQualidadeAr
export type SensorResponse = CreatedJson<SensorQualidadeAr>
export type QualidadeArComSensor = Prisma.QualidadeArGetPayload<{ include: { sensor: true } }>
export type QualidadeArResponse = Omit<ReadingJson<QualidadeArComSensor>, 'sensor'> & { sensor: SensorResponse }

export function isSensorBody(value: unknown): value is SensorBody {
  return isRecord(value) && isNonEmptyString(value.nome) &&
    (value.tipo === TipoSensorQualidadeAr.MP25 || value.tipo === TipoSensorQualidadeAr.CO || value.tipo === TipoSensorQualidadeAr.NO2 || value.tipo === TipoSensorQualidadeAr.TEMPERATURA) && isNonEmptyString(value.estacao)
}

export function isQualidadeArBody(value: unknown): value is QualidadeArBody {
  if (!isRecord(value) || !isSensorId(value.sensorId) || typeof value.timestamp !== 'string') return false
  return (
    (isFiniteNumber(value.mp25) && value.co === undefined && value.no2 === undefined && value.temperatura === undefined) ||
    (value.mp25 === undefined && isFiniteNumber(value.co) && value.no2 === undefined && value.temperatura === undefined) ||
    (value.mp25 === undefined && value.co === undefined && isFiniteNumber(value.no2) && value.temperatura === undefined) ||
    (value.mp25 === undefined && value.co === undefined && value.no2 === undefined && isFiniteNumber(value.temperatura))
  )
}
