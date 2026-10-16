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

  app.get('/get/transito', async (_req, res) => {
    try {
      res.json(await prisma.transito.findMany())
    } catch (error) {
      console.error(error)
      res.status(500).json({ error: 'erro ao consultar as leituras' })
    }
  })

  app.post('/send/transito', async (req, res) => {
    const { timestamp, posicao, velocidade, ocupacao } = req.body ?? {}

    if (!isNonEmptyString(posicao) || !isFiniteNumber(velocidade) || !isFiniteNumber(ocupacao)) {
      res.status(400).json({ error: 'timestamp, posicao, velocidade e ocupacao sao obrigatorios' })
      return
    }

    const sensorTimestamp = parseSensorTimestamp(timestamp)
    if (!sensorTimestamp) {
      res.status(400).json({ error: 'timestamp deve ser uma data ISO 8601 valida com fuso horario' })
      return
    }

    try {
      const leitura = await prisma.transito.create({
        data: { timestamp: sensorTimestamp, posicao, velocidade, ocupacao }
      })
      res.status(201).json(leitura)
    } catch (error) {
      console.error(error)
      res.status(500).json({ error: 'erro ao salvar a leitura' })
    }
  })

  return app
}