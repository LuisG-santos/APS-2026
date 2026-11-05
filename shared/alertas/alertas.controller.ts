import type { DominioAlerta } from '@prisma/client'
import type { Request, Response } from 'express'
import { serializeReading } from '../serialization.js'
import type { createAlertasService } from './alertas.service.js'

export function createAlertasController(service: ReturnType<typeof createAlertasService>, dominio: DominioAlerta) {
  return {
    async listar(_req: Request, res: Response): Promise<void> {
      try {
        res.json((await service.listar(dominio)).map(serializeReading))
      } catch (error) {
        console.error(error)
        res.status(500).json({ error: 'erro ao consultar os alertas' })
      }
    }
  }
}
