import type { ApiRequest, ApiResponse } from '../../shared/http.js'
import { serializeCreated, serializeReading } from '../../shared/serialization.js'
import { isAlagamentoBody, type AlagamentoComSensor, type AlagamentoResponse } from '../contracts.js'
import { ErroAlagamento } from '../errors.js'
import type { LeiturasService } from '../services/leituras.service.js'

function serializeLeitura(leitura: AlagamentoComSensor): AlagamentoResponse {
  return { ...serializeReading(leitura), sensor: serializeCreated(leitura.sensor) }
}

export function createLeiturasController(service: LeiturasService) {
  return {
    async listar(_req: ApiRequest<AlagamentoResponse[]>, res: ApiResponse<AlagamentoResponse[]>): Promise<void> {
      try {
        const leituras = await service.listar()
        res.json(leituras.map(serializeLeitura))
      } catch (error) {
        console.error(error)
        res.status(500).json({ error: 'erro ao consultar as leituras' })
      }
    },
    async registrar(req: ApiRequest<AlagamentoResponse>, res: ApiResponse<AlagamentoResponse>): Promise<void> {
      const body: unknown = req.body
      if (!isAlagamentoBody(body)) {
        res.status(400).json({ error: 'envie sensorId inteiro positivo, timestamp e uma unica medida com o tipo correto' })
        return
      }
      try {
        const leitura = await service.registrar(body)
        res.status(201).json(serializeLeitura(leitura))
      } catch (error) {
        if (error instanceof ErroAlagamento && error.codigo !== 'NOME_DUPLICADO') {
          res.status(error.codigo === 'SENSOR_NAO_ENCONTRADO' ? 404 : 400).json({ error: error.message })
          return
        }
        console.error(error)
        res.status(500).json({ error: 'erro ao salvar a leitura' })
      }
    }
  }
}
