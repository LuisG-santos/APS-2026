import type { Alagamento } from '@prisma/client'
import type { ReadingJson } from '../shared/serialization.js'
import { isFiniteNumber, isNonEmptyString, isRecord } from '../shared/validation.js'

export interface AlagamentoBody {
  sensor: string
  timestamp: string
  nivelCorregoCm: number
  chuvaAcumuladaMm: number
}

export type AlagamentoResponse = ReadingJson<Alagamento>

export function isAlagamentoBody(value: unknown): value is AlagamentoBody {
  return isRecord(value) &&
    isNonEmptyString(value.sensor) &&
    typeof value.timestamp === 'string' &&
    isFiniteNumber(value.nivelCorregoCm) &&
    isFiniteNumber(value.chuvaAcumuladaMm)
}
