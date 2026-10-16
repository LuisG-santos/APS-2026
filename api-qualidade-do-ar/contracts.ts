import { TipoSensorQualidadeAr, type Prisma, type SensorQualidadeAr } from '@prisma/client'
import type { CreatedJson, ReadingJson } from '../shared/serialization.js'
import { isFiniteNumber, isNonEmptyString, isRecord, isSensorId } from '../shared/validation.js'

export interface SensorQualidadeArBody {
  nome: string
  tipo: TipoSensorQualidadeAr
}

export interface Mp25Medida {
  mp25: number
  co?: never
  no3?: never
  temperatura?: never
}

export interface CoMedida {
  mp25?: never
  co: number
  no3?: never
  temperatura?: never
}

export interface No3Medida {
  mp25?: never
  co?: never
  no3: number
  temperatura?: never
}

export interface TemperaturaMedida {
  mp25?: never
  co?: never
  no3?: never
  temperatura: number
}

export type MedidaQualidadeAr = Mp25Medida | CoMedida | No3Medida | TemperaturaMedida

export type QualidadeArBody = {
  sensorId: number
  timestamp: string
  estacao: string
} & MedidaQualidadeAr

export type SensorQualidadeArResponse = CreatedJson<SensorQualidadeAr>
export type QualidadeArComSensor = Prisma.QualidadeArGetPayload<{ include: { sensor: true } }>
export type QualidadeArResponse = Omit<ReadingJson<QualidadeArComSensor>, 'sensor'> & {
  sensor: SensorQualidadeArResponse
}

function isTipoSensor(value: unknown): value is TipoSensorQualidadeAr {
  return value === TipoSensorQualidadeAr.MP25 || value === TipoSensorQualidadeAr.CO || value === TipoSensorQualidadeAr.NO3 || value === TipoSensorQualidadeAr.TEMPERATURA
}

export function isSensorQualidadeArBody(value: unknown): value is SensorQualidadeArBody {
  return isRecord(value) && isNonEmptyString(value.nome) && isTipoSensor(value.tipo)
}

export function isQualidadeArBody(value: unknown): value is QualidadeArBody {
  if (!isRecord(value) || !isSensorId(value.sensorId) || typeof value.timestamp !== 'string' || !isNonEmptyString(value.estacao)) return false
  return (
    (isFiniteNumber(value.mp25) && value.co === undefined && value.no3 === undefined && value.temperatura === undefined) ||
    (value.mp25 === undefined && isFiniteNumber(value.co) && value.no3 === undefined && value.temperatura === undefined) ||
    (value.mp25 === undefined && value.co === undefined && isFiniteNumber(value.no3) && value.temperatura === undefined) ||
    (value.mp25 === undefined && value.co === undefined && value.no3 === undefined && isFiniteNumber(value.temperatura))
  )
}

export function medidaParaSensor(body: QualidadeArBody, tipo: TipoSensorQualidadeAr): MedidaQualidadeAr | null {
  switch (tipo) {
    case TipoSensorQualidadeAr.MP25:
      return isFiniteNumber(body.mp25) ? { mp25: body.mp25 } : null
    case TipoSensorQualidadeAr.CO:
      return isFiniteNumber(body.co) ? { co: body.co } : null
    case TipoSensorQualidadeAr.NO3:
      return isFiniteNumber(body.no3) ? { no3: body.no3 } : null
    case TipoSensorQualidadeAr.TEMPERATURA:
      return isFiniteNumber(body.temperatura) ? { temperatura: body.temperatura } : null
  }
}
