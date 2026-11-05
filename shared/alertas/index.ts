import 'dotenv/config'
import express from 'express'
import { PrismaClient } from '@prisma/client'
import { createAlertasRepository } from './alertas.repository.js'
import { carregarLimites } from './alertas.service.js'
import { iniciarWorker } from './worker.js'

const limites = carregarLimites(process.env)
const url = process.env.RABBITMQ_URL?.trim()
if (!url) throw new Error('Configure RABBITMQ_URL para iniciar o worker')
const port = Number(process.env.WORKER_PORT ?? 3004)
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('WORKER_PORT invalida')
const prisma = new PrismaClient()
const worker = iniciarWorker(createAlertasRepository(prisma), url, limites)
const app = express()
app.get('/health/live', (_req, res) => { res.json({ status: 'ok' }) })
app.get('/health/ready', async (_req, res) => {
  try { await worker.verificarConexao(); res.json({ status: 'ready' }) }
  catch { res.status(503).json({ status: 'unavailable' }) }
})
const server = app.listen(port, () => { console.log(`Worker: health na porta ${port}`) })
function encerrar() {
  server.close(() => {
    void worker.fechar().then(() => prisma.$disconnect()).catch(() => { process.exitCode = 1 })
  })
}
process.once('SIGINT', encerrar)
process.once('SIGTERM', encerrar)
