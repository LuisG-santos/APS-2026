import express, { type Express } from 'express'
import { Prisma, type PrismaClient } from '@prisma/client'
import type { ApiRequest, ApiResponse, LiveResponse, ReadyResponse } from '../shared/http.js'
import { serializeCreated, serializeReading } from '../shared/serialization.js'
import { parseSensorTimestamp } from '../shared/validation.js'
import {
  isSensorBody, isTransitoBody, medidaParaSensor,
  type SensorResponse, type TransitoComSensor, type TransitoResponse
} from './contracts.js'

function serializeLeitura(leitura: TransitoComSensor): TransitoResponse {
  return { ...serializeReading(leitura), sensor: serializeCreated(leitura.sensor) }
}

export function createApp(prisma: PrismaClient): Express {
  const app = express()
  app.use(express.json())

  app.get('/health/live', (_req: ApiRequest<LiveResponse>, res: ApiResponse<LiveResponse>): void => {
    res.status(200).json({ status: 'ok' })
  })

  app.get('/health/ready', async (_req: ApiRequest<ReadyResponse>, res: ApiResponse<ReadyResponse>): Promise<void> => {
    try {
      await prisma.$queryRaw`SELECT 1`
      res.status(200).json({ status: 'ready' })
    } catch (error) {
      console.error(error)
      res.status(503).json({ status: 'unavailable' })
    }
  })

  app.get('/get/transito', async (_req: ApiRequest<TransitoResponse[]>, res: ApiResponse<TransitoResponse[]>): Promise<void> => {
    try {
      const leituras = await prisma.transito.findMany({ include: { sensor: true } })
      res.json(leituras.map(serializeLeitura))
    } catch (error) {
      console.error(error)
      res.status(500).json({ error: 'erro ao consultar as leituras' })
    }
  })

  app.get('/get/sensores', async (_req: ApiRequest<SensorResponse[]>, res: ApiResponse<SensorResponse[]>): Promise<void> => {
    try {
      const sensores = await prisma.sensorTransito.findMany()
      res.json(sensores.map(serializeCreated))
    } catch (error) {
      console.error(error)
      res.status(500).json({ error: 'erro ao consultar os sensores' })
    }
  })

  app.post('/send/sensor', async (req: ApiRequest<SensorResponse>, res: ApiResponse<SensorResponse>): Promise<void> => {
    const body: unknown = req.body
    if (!isSensorBody(body)) {
      res.status(400).json({ error: 'nome e tipo sao obrigatorios; tipo deve ser RADAR, GPS ou OCUPACAO' })
      return
    }

    const data: Prisma.SensorTransitoCreateInput = { nome: body.nome.trim(), tipo: body.tipo }
    try {
      const sensor = await prisma.sensorTransito.create({ data })
      res.status(201).json(serializeCreated(sensor))
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        res.status(409).json({ error: 'ja existe um sensor com esse nome' })
        return
      }
      console.error(error)
      res.status(500).json({ error: 'erro ao cadastrar o sensor' })
    }
  })

  app.post('/send/transito', async (req: ApiRequest<TransitoResponse>, res: ApiResponse<TransitoResponse>): Promise<void> => {
    const body: unknown = req.body
    if (!isTransitoBody(body)) {
      res.status(400).json({ error: 'envie sensorId inteiro positivo, timestamp e uma unica medida com o tipo correto' })
      return
    }

    const sensorTimestamp = parseSensorTimestamp(body.timestamp)
    if (!sensorTimestamp) {
      res.status(400).json({ error: 'timestamp deve ser uma data ISO 8601 valida com fuso horario' })
      return
    }

    try {
      const sensor = await prisma.sensorTransito.findUnique({ where: { id: body.sensorId } })
      if (!sensor) {
        res.status(404).json({ error: 'sensor nao encontrado' })
        return
      }

      const medida = medidaParaSensor(body, sensor.tipo)
      if (!medida) {
        res.status(400).json({ error: `medida incompativel com o sensor ${sensor.tipo}` })
        return
      }

      const data: Prisma.TransitoUncheckedCreateInput = { sensorId: body.sensorId, timestamp: sensorTimestamp, ...medida }
      const leitura = await prisma.transito.create({ data, include: { sensor: true } })
      res.status(201).json(serializeLeitura(leitura))
    } catch (error) {
      console.error(error)
      res.status(500).json({ error: 'erro ao salvar a leitura' })
    }
  })

  return app
}
