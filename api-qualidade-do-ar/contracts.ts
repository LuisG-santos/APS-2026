import type { QualidadeAr } from '@prisma/client'
import type { ReadingJson } from '../shared/serialization.js'
import { isFiniteNumber, isNonEmptyString, isRecord } from '../shared/validation.js'

export interface QualidadeArBody {
  sensor: string
  estacao: string
  timestamp: string
  mp25: number
  co: number
  no3: number
  temperatura: number
}

export type QualidadeArResponse = ReadingJson<QualidadeAr>

export function isQualidadeArBody(value: unknown): value is QualidadeArBody {
  return isRecord(value) &&
    isNonEmptyString(value.sensor) &&
    isNonEmptyString(value.estacao) &&
    typeof value.timestamp === 'string' &&
    isFiniteNumber(value.mp25) &&
    isFiniteNumber(value.co) &&
    isFiniteNumber(value.no3) &&
    isFiniteNumber(value.temperatura)
}
