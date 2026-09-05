import "dotenv/config"
import express, { type Request, type Response } from 'express'
import { PrismaClient } from './generated/prisma/client.js'

const app = express()
const prisma = new PrismaClient()
const port = 3003

app.use(express.json())

app.post('/send', (req: Request, res: Response) => {
	const { veiculo, timestamp, posicao, velocidade, ocupacao } = req.body

	if (
		typeof veiculo !== 'string' ||
		typeof timestamp !== 'string' ||
		typeof posicao !== 'string' ||
		typeof velocidade !== 'number' ||
		typeof ocupacao !== 'number'
	) {
		res.status(400).json({
			error: 'veiculo, timestamp, posicao, velocidade e ocupacao sao obrigatorios'
		})
		return
	}

	const data = new Date(timestamp)

	if (Number.isNaN(data.getTime())) {
		res.status(400).json({ error: 'timestamp invalido' })
		return
	}

	prisma.transito.create({
		data: {
			veiculo,
			timestamp: data,
			posicao,
			velocidade,
			ocupacao
		}
	})
		.then((transito) => res.status(201).json(transito))
		.catch((err) => {
			console.error(err)
			res.status(500).json({ error: 'erro ao salvar a leitura' })
		})
	
})

app.listen(port, () => {
	console.log(`API rodando em http://localhost:${port}`)
})