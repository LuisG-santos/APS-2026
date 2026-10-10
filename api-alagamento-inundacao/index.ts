import "dotenv/config"
import express, { type Request, type Response } from 'express'
import { PrismaClient } from './generated/prisma/client.js'

const app = express()
const prisma = new PrismaClient()
const port = Number(process.env.PORT ?? 3001)

app.use(express.json())

app.get('/health/live', (_req: Request, res: Response) => {
	res.status(200).json({ status: 'ok' })
})

app.get('/health/ready', async (_req: Request, res: Response) => {
	try {
		await prisma.$queryRaw`SELECT 1`
		res.status(200).json({ status: 'ready' })
	} catch (error) {
		console.error(error)
		res.status(503).json({ status: 'unavailable' })
	}
})

app.get( '/get/alagamento', async(req: Request, res: Response)=> {
	res.json( await prisma.alagamento.findMany())
})

app.post('/send/alagamento', (req: Request, res: Response) => {
	const { sensor, timestamp, nivelCorregoCm, chuvaAcumuladaMm } = req.body

	if (
		typeof sensor !== 'string' ||
		typeof timestamp !== 'string' ||
		typeof nivelCorregoCm !== 'number' ||
		typeof chuvaAcumuladaMm !== 'number'
	) {
		res.status(400).json({
			error: 'sensor, timestamp, nivelCorregoCm e chuvaAcumuladaMm sao obrigatorios'
		})
		return
	}

	const data = new Date(timestamp)

	if (Number.isNaN(data.getTime())) {
		res.status(400).json({ error: 'timestamp invalido' })
		return
	}

	prisma.alagamento.create({
		data: {
			sensor,
			timestamp: data,
			nivelCorregoCm,
			chuvaAcumuladaMm
		}
	})
		.then((alagamento) => res.status(201).json(alagamento))
		.catch((err) => {
			console.error(err)
			res.status(500).json({ error: 'erro ao salvar a leitura' })
		})
	
})

app.listen(port, () => {
	console.log(`API rodando em http://localhost:${port}`)
})