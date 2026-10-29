import { TipoSensorTransito, type Prisma, type SensorTransito } from '@prisma/client'
import type { CreatedJson, ReadingJson } from '../shared/serialization.js'
import { isFiniteNumber, isNonEmptyString, isRecord, isSensorId } from '../shared/validation.js'

export interface SensorBody {
  nome: string
  tipo: TipoSensorTransito
}

export interface RadarMedida {
  velocidade: number
  posicao?: never
  ocupacao?: never
}

export interface GpsMedida {
  posicao: string
  velocidade?: never
  ocupacao?: never
}

export interface OcupacaoMedida {
  ocupacao: number
  posicao?: never
  velocidade?: never
}

export type MedidaTransito = RadarMedida | GpsMedida | OcupacaoMedida

export type TransitoBody = {
  sensorId: number
  timestamp: string
} & MedidaTransito

export type SensorResponse = CreatedJson<SensorTransito>
export type TransitoComSensor = Prisma.TransitoGetPayload<{ include: { sensor: true } }>
export type TransitoResponse = Omit<ReadingJson<TransitoComSensor>, 'sensor'> & {
  sensor: SensorResponse
}

function isTipoSensor(value: unknown): value is TipoSensorTransito {
  return value === TipoSensorTransito.RADAR || value === TipoSensorTransito.GPS || value === TipoSensorTransito.OCUPACAO
}

export function isSensorBody(value: unknown): value is SensorBody {
  return isRecord(value) && isNonEmptyString(value.nome) && isTipoSensor(value.tipo)
}

export function isTransitoBody(value: unknown): value is TransitoBody {
  if (!isRecord(value) || !isSensorId(value.sensorId) || typeof value.timestamp !== 'string') return false

  const { posicao, velocidade, ocupacao } = value
  return (
    (isFiniteNumber(velocidade) && posicao === undefined && ocupacao === undefined) ||
    (isNonEmptyString(posicao) && velocidade === undefined && ocupacao === undefined) ||
    (isFiniteNumber(ocupacao) && posicao === undefined && velocidade === undefined)
  )
}

export function medidaParaSensor(body: TransitoBody, tipo: TipoSensorTransito): MedidaTransito | null {
  switch (tipo) {
    case TipoSensorTransito.RADAR:
      return isFiniteNumber(body.velocidade) ? { velocidade: body.velocidade } : null
    case TipoSensorTransito.GPS:
      return isNonEmptyString(body.posicao) ? { posicao: body.posicao } : null
    case TipoSensorTransito.OCUPACAO:
      return isFiniteNumber(body.ocupacao) ? { ocupacao: body.ocupacao } : null
  }
}
