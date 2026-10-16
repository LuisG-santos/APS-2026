import express from 'express'
import { Prisma, TipoSensorTransito, type PrismaClient } from '@prisma/client'
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
      res.json(await prisma.transito.findMany({ include: { sensor: true } }))
    } catch (error) {
      console.error(error)
      res.status(500).json({ error: 'erro ao consultar as leituras' })
    }
  })

  app.get('/get/sensores', async (_req, res) => {
    try {
      res.json(await prisma.sensorTransito.findMany())
    } catch (error) {
      console.error(error)
      res.status(500).json({ error: 'erro ao consultar os sensores' })
    }
  })

  app.post('/send/sensor', async (req, res) => {
    const { nome, tipo } = req.body ?? {}

    if (!isNonEmptyString(nome) || !Object.values(TipoSensorTransito).includes(tipo)) {
      res.status(400).json({ error: 'nome e tipo sao obrigatorios; tipo deve ser RADAR, GPS ou OCUPACAO' })
      return
    }

    try {
      const sensor = await prisma.sensorTransito.create({ data: { nome: nome.trim(), tipo } })
      res.status(201).json(sensor)
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        res.status(409).json({ error: 'ja existe um sensor com esse nome' })
        return
      }
      console.error(error)
      res.status(500).json({ error: 'erro ao cadastrar o sensor' })
    }
  })

  app.post('/send/transito', async (req, res) => {
    const { sensorId, timestamp, posicao, velocidade, ocupacao } = req.body ?? {}

    if (!Number.isSafeInteger(sensorId) || sensorId <= 0 || sensorId > 2147483647) {
      res.status(400).json({ error: 'sensorId deve ser o ID inteiro positivo de um sensor cadastrado' })
      return
    }

    const sensorTimestamp = parseSensorTimestamp(timestamp)
    if (!sensorTimestamp) {
      res.status(400).json({ error: 'timestamp deve ser uma data ISO 8601 valida com fuso horario' })
      return
    }

    try {
      const sensor = await prisma.sensorTransito.findUnique({ where: { id: sensorId } })
      if (!sensor) {
        res.status(404).json({ error: 'sensor nao encontrado' })
        return
      }

      const campos = ['posicao', 'velocidade', 'ocupacao'] as const
      const campoPorTipo = {
        RADAR: 'velocidade',
        GPS: 'posicao',
        OCUPACAO: 'ocupacao'
      } as const
      const campo = campoPorTipo[sensor.tipo]
      const valores = { posicao, velocidade, ocupacao }
      const valor = valores[campo]
      const outraMedida = campos.some(nome => nome !== campo && valores[nome] !== undefined)
      const valorValido = campo === 'posicao' ? isNonEmptyString(valor) : isFiniteNumber(valor)

      if (outraMedida || !valorValido) {
        res.status(400).json({ error: `sensor ${sensor.tipo} deve enviar somente ${campo}, alem de sensorId e timestamp` })
        return
      }

      const medida = campo === 'posicao' ? { posicao: valor as string } : { [campo]: valor as number }
      const leitura = await prisma.transito.create({
        data: {
          sensorId,
          timestamp: sensorTimestamp,
          ...medida
        },
        include: { sensor: true }
      })
      res.status(201).json(leitura)
    } catch (error) {
      console.error(error)
      res.status(500).json({ error: 'erro ao salvar a leitura' })
    }
  })

  return app
}
