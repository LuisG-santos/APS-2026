import express, { type Express } from 'express'
import type { Prisma, PrismaClient } from '@prisma/client'
import type { ApiRequest, ApiResponse, LiveResponse, ReadyResponse } from '../shared/http.js'
import { serializeReading } from '../shared/serialization.js'
import { parseSensorTimestamp } from '../shared/validation.js'
import { isQualidadeArBody, type QualidadeArResponse } from './contracts.js'

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

  app.get('/get/qualidade-ar', async (_req: ApiRequest<QualidadeArResponse[]>, res: ApiResponse<QualidadeArResponse[]>): Promise<void> => {
    try {
      const leituras = await prisma.qualidadeAr.findMany()
      res.json(leituras.map(serializeReading))
    } catch (error) {
      console.error(error)
      res.status(500).json({ error: 'erro ao consultar as leituras' })
    }
  })

  app.post('/send/qualidade-ar', async (req: ApiRequest<QualidadeArResponse>, res: ApiResponse<QualidadeArResponse>): Promise<void> => {
    const body: unknown = req.body
    if (!isQualidadeArBody(body)) {
      res.status(400).json({ error: 'sensor, estacao, timestamp, mp25, co, no3 e temperatura sao obrigatorios e devem ter os tipos corretos' })
      return
    }

    const sensorTimestamp = parseSensorTimestamp(body.timestamp)
    if (!sensorTimestamp) {
      res.status(400).json({ error: 'timestamp deve ser uma data ISO 8601 valida com fuso horario' })
      return
    }

    const { sensor, estacao, mp25, co, no3, temperatura } = body
    const data: Prisma.QualidadeArCreateInput = { sensor, estacao, timestamp: sensorTimestamp, mp25, co, no3, temperatura }
    try {
      const leitura = await prisma.qualidadeAr.create({ data })
      res.status(201).json(serializeReading(leitura))
    } catch (error) {
      console.error(error)
      res.status(500).json({ error: 'erro ao salvar a leitura' })
    }
  })

  return app
}
