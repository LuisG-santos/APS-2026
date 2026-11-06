import { createAlertasRepository } from '../shared/alertas/alertas.repository.js'
import { createAlertasService } from '../shared/alertas/alertas.service.js'
import { createAlertasController } from '../shared/alertas/alertas.controller.js'
import { semCache, type Cache } from '../shared/cache.js'
import express, { type Express } from 'express'
import type { PrismaClient } from '@prisma/client'
import type { ApiRequest, ApiResponse, LiveResponse, ReadyResponse } from '../shared/http.js'
import { createSensoresController } from './controllers/sensores.controller.js'
import { createLeiturasController } from './controllers/leituras.controller.js'
import { createSensoresService } from './services/sensores.service.js'
import { createLeiturasService } from './services/leituras.service.js'
import { createSensoresRepository } from './repositories/sensores.repository.js'
import { createLeiturasRepository } from './repositories/leituras.repository.js'

export function createApp(prisma: PrismaClient, cache: Cache = semCache): Express {
  const sensoresRepository = createSensoresRepository(prisma, cache)
  const leiturasRepository = createLeiturasRepository(prisma)
  const sensoresService = createSensoresService(sensoresRepository)
  const leiturasService = createLeiturasService(leiturasRepository, sensoresRepository)
  const sensoresController = createSensoresController(sensoresService)
  const leiturasController = createLeiturasController(leiturasService)

  const app = express()
  app.use(express.json())

  app.get('/health/live', (_req: ApiRequest<LiveResponse>, res: ApiResponse<LiveResponse>): void => {
    res.status(200).json({ status: 'ok' })
  })

  app.get('/health/ready', async (_req: ApiRequest<ReadyResponse>, res: ApiResponse<ReadyResponse>): Promise<void> => {
    try {
      await leiturasService.verificarConexao()
      res.status(200).json({ status: 'ready' })
    } catch (error) {
      console.error(error)
      res.status(503).json({ status: 'unavailable' })
    }
  })

  const alertasService = createAlertasService(createAlertasRepository(prisma))
  const alertasController = createAlertasController(alertasService, 'TRANSITO')
  app.get('/get/alertas', alertasController.listar)
  app.get('/get/sensores', sensoresController.listar)
  app.post('/send/sensor', sensoresController.cadastrar)
  app.get('/get/transito', leiturasController.listar)
  app.post('/send/transito', leiturasController.registrar)

  return app
}
