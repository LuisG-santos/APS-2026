import express from 'express'
import type { PrismaClient } from '@prisma/client'
import { isFiniteNumber, isNonEmptyString, parseSensorTimestamp } from '../shared/validation.js'

export function createApp(prisma: PrismaClient) {
  const app = express()
  app.use(express.json())

  app.get('/health/live', (_req, res) => {
    res.status(200).json({ status: 'ok' })
  })

  app.get('/health/ready', async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`
      res.status(200).json({ status: 'ready' })
    } catch (error) {
      console.error(error)
      res.status(503).json({ status: 'unavailable' })
    }
  })

  app.get('/get/qualidade-ar', async (_req, res) => {
    try {
      res.json(await prisma.qualidadeAr.findMany())
    } catch (error) {
      console.error(error)
      res.status(500).json({ error: 'erro ao consultar as leituras' })
    }
  })

  app.post('/send/qualidade-ar', async (req, res) => {
    const { sensor, estacao, timestamp, mp25, co, no3, temperatura } = req.body ?? {}

    if (
      !isNonEmptyString(sensor) ||
      !isNonEmptyString(estacao) ||
      !isFiniteNumber(mp25) ||
      !isFiniteNumber(co) ||
      !isFiniteNumber(no3) ||
      !isFiniteNumber(temperatura)
    ) {
      res.status(400).json({ error: 'sensor, estacao, timestamp, mp25, co, no3 e temperatura sao obrigatorios' })
      return
    }

    const sensorTimestamp = parseSensorTimestamp(timestamp)
    if (!sensorTimestamp) {
      res.status(400).json({ error: 'timestamp deve ser uma data ISO 8601 valida com fuso horario' })
      return
    }

    try {
      const leitura = await prisma.qualidadeAr.create({
        data: { sensor, estacao, timestamp: sensorTimestamp, mp25, co, no3, temperatura }
      })
      res.status(201).json(leitura)
    } catch (error) {
      console.error(error)
      res.status(500).json({ error: 'erro ao salvar a leitura' })
    }
  })

  return app
}