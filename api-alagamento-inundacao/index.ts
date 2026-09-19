import "dotenv/config"
import express, { type Request, type Response } from 'express'
import { PrismaClient } from './generated/prisma/client.js'

const app = express()
const prisma = new PrismaClient()
const port = 3001

app.use(express.json())

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