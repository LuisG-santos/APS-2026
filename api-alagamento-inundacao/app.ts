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

  app.get('/get/alagamento', async (_req, res) => {
    try {
      res.json(await prisma.alagamento.findMany())
    } catch (error) {
      console.error(error)
      res.status(500).json({ error: 'erro ao consultar as leituras' })
    }
  })

  app.post('/send/alagamento', async (req, res) => {
    const { sensor, timestamp, nivelCorregoCm, chuvaAcumuladaMm } = req.body ?? {}

    if (
      !isNonEmptyString(sensor) ||
      !isFiniteNumber(nivelCorregoCm) ||
      !isFiniteNumber(chuvaAcumuladaMm)
    ) {
      res.status(400).json({ error: 'sensor, timestamp, nivelCorregoCm e chuvaAcumuladaMm sao obrigatorios' })
      return
    }

    const sensorTimestamp = parseSensorTimestamp(timestamp)
    if (!sensorTimestamp) {
      res.status(400).json({ error: 'timestamp deve ser uma data ISO 8601 valida com fuso horario' })
      return
    }

    try {
      const leitura = await prisma.alagamento.create({
        data: { sensor, timestamp: sensorTimestamp, nivelCorregoCm, chuvaAcumuladaMm }
      })
      res.status(201).json(leitura)
    } catch (error) {
      console.error(error)
      res.status(500).json({ error: 'erro ao salvar a leitura' })
    }
  })

  return app
}