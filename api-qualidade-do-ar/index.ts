import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import { createApp } from './app.js'

const prisma = new PrismaClient()
const port = Number(process.env.PORT ?? 3002)

createApp(prisma).listen(port, () => {
	console.log(`API rodando em http://localhost:${port}`)
})