import type { ApiRequest, ApiResponse } from '../../shared/http.js'
import { serializeCreated } from '../../shared/serialization.js'
import { isSensorBody, type SensorResponse } from '../contracts.js'
import { ErroTransito } from '../errors.js'
import type { SensoresService } from '../services/sensores.service.js'

export function createSensoresController(service: SensoresService) {
  return {
    async listar(_req: ApiRequest<SensorResponse[]>, res: ApiResponse<SensorResponse[]>): Promise<void> {
      try {
        const sensores = await service.listar()
        res.json(sensores.map(serializeCreated))
      } catch (error) {
        console.error(error)
        res.status(500).json({ error: 'erro ao consultar os sensores' })
      }
    },
    async cadastrar(req: ApiRequest<SensorResponse>, res: ApiResponse<SensorResponse>): Promise<void> {
      const body: unknown = req.body
      if (!isSensorBody(body)) {
        res.status(400).json({ error: 'nome e tipo sao obrigatorios; tipo deve ser RADAR, GPS ou OCUPACAO' })
        return
      }
      try {
        const sensor = await service.cadastrar(body)
        res.status(201).json(serializeCreated(sensor))
      } catch (error) {
        if (error instanceof ErroTransito && error.codigo === 'NOME_DUPLICADO') {
          res.status(409).json({ error: error.message })
          return
        }
        console.error(error)
        res.status(500).json({ error: 'erro ao cadastrar o sensor' })
      }
    }
  }
}
