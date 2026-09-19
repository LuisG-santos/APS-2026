import "dotenv/config"
import express, { type Request, type Response } from 'express'
import { PrismaClient } from './generated/prisma/client.js'

const app = express()
const prisma = new PrismaClient()
const port = 3002

app.use(express.json())

app.get( '/get/qualidade-ar', async(req: Request, res: Response)=> {
	res.json( await prisma.qualidadeAr.findMany())
})

app.post('/send/qualidade-ar', (req: Request, res: Response) => {
	const { estacao, timestamp, mp25, co, no3, temperatura } = req.body

	if (
		typeof estacao !== 'string' ||
		typeof timestamp !== 'string' ||
		typeof mp25 !== 'number' ||
		typeof co !== 'number' ||
		typeof no3 !== 'number' ||
		typeof temperatura !== 'number'
	) {
		res.status(400).json({
			error: 'estação, timestamp, mp25, co, no3 e temperatura sao obrigatorios'
		})
		return
	}

	const data = new Date(timestamp)

	if (Number.isNaN(data.getTime())) {
		res.status(400).json({ error: 'timestamp invalido' })
		return
	}

	prisma.qualidadeAr.create({
		data: {
			estacao,
			timestamp: data,
			mp25,
			co,
			no3,
			temperatura
		}
	})
		.then((qualidadeAr) => res.status(201).json(qualidadeAr))
		.catch((err) => {
			console.error(err)
			res.status(500).json({ error: 'erro ao salvar a leitura' })
		})

})

app.listen(port, () => {
	console.log(`API rodando em http://localhost:${port}`)
})