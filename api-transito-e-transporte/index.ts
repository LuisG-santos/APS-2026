import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import { createCacheRedis } from '../shared/cache.js'
import { createApp } from './app.js'

const prisma = new PrismaClient()
const cache = createCacheRedis(process.env.REDIS_URL)
const port = Number(process.env.PORT ?? 3003)

const server = createApp(prisma, cache).listen(port, () => {
  console.log(`API rodando em http://localhost:${port}`)
})

function encerrar() {
  server.close(() => {
    cache.fechar()
    void prisma.$disconnect().catch(console.error)
  })
}
process.once('SIGTERM', encerrar)
process.once('SIGINT', encerrar)
