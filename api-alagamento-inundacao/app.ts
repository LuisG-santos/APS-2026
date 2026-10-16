import express, { type Express } from 'express'
import type { Prisma, PrismaClient } from '@prisma/client'
import type { ApiRequest, ApiResponse, LiveResponse, ReadyResponse } from '../shared/http.js'
import { serializeReading } from '../shared/serialization.js'
import { parseSensorTimestamp } from '../shared/validation.js'
import { isAlagamentoBody, type AlagamentoResponse } from './contracts.js'

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

  app.get('/get/alagamento', async (_req: ApiRequest<AlagamentoResponse[]>, res: ApiResponse<AlagamentoResponse[]>): Promise<void> => {
    try {
      const leituras = await prisma.alagamento.findMany()
      res.json(leituras.map(serializeReading))
    } catch (error) {
      console.error(error)
      res.status(500).json({ error: 'erro ao consultar as leituras' })
    }
  })

  app.post('/send/alagamento', async (req: ApiRequest<AlagamentoResponse>, res: ApiResponse<AlagamentoResponse>): Promise<void> => {
    const body: unknown = req.body
    if (!isAlagamentoBody(body)) {
      res.status(400).json({ error: 'sensor, timestamp, nivelCorregoCm e chuvaAcumuladaMm sao obrigatorios e devem ter os tipos corretos' })
      return
    }

    const sensorTimestamp = parseSensorTimestamp(body.timestamp)
    if (!sensorTimestamp) {
      res.status(400).json({ error: 'timestamp deve ser uma data ISO 8601 valida com fuso horario' })
      return
    }

    const { sensor, nivelCorregoCm, chuvaAcumuladaMm } = body
    const data: Prisma.AlagamentoCreateInput = { sensor, timestamp: sensorTimestamp, nivelCorregoCm, chuvaAcumuladaMm }
    try {
      const leitura = await prisma.alagamento.create({ data })
      res.status(201).json(serializeReading(leitura))
    } catch (error) {
      console.error(error)
      res.status(500).json({ error: 'erro ao salvar a leitura' })
    }
  })

  return app
}
