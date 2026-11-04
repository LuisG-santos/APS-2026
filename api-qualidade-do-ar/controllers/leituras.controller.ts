import type { ApiRequest, ApiResponse } from '../../shared/http.js'
import { serializeCreated, serializeReading } from '../../shared/serialization.js'
import { isQualidadeArBody, type QualidadeArComSensor, type QualidadeArResponse } from '../contracts.js'
import { ErroQualidadeAr } from '../errors.js'
import type { LeiturasService } from '../services/leituras.service.js'

function serializeLeitura(leitura: QualidadeArComSensor): QualidadeArResponse {
  return { ...serializeReading(leitura), sensor: serializeCreated(leitura.sensor) }
}

export function createLeiturasController(service: LeiturasService) {
  return {
    async listar(_req: ApiRequest<QualidadeArResponse[]>, res: ApiResponse<QualidadeArResponse[]>): Promise<void> {
      try {
        const leituras = await service.listar()
        res.json(leituras.map(serializeLeitura))
      } catch (error) {
        console.error(error)
        res.status(500).json({ error: 'erro ao consultar as leituras' })
      }
    },
    async registrar(req: ApiRequest<QualidadeArResponse>, res: ApiResponse<QualidadeArResponse>): Promise<void> {
      const body: unknown = req.body
      if (!isQualidadeArBody(body)) {
        res.status(400).json({ error: 'envie sensorId inteiro positivo, timestamp e uma unica medida com o tipo correto; estacao pertence ao cadastro e no3 foi substituido por no2' })
        return
      }
      try {
        const leitura = await service.registrar(body)
        res.status(201).json(serializeLeitura(leitura))
      } catch (error) {
        if (error instanceof ErroQualidadeAr && error.codigo !== 'NOME_DUPLICADO') {
          res.status(error.codigo === 'SENSOR_NAO_ENCONTRADO' ? 404 : 400).json({ error: error.message })
          return
        }
        console.error(error)
        res.status(500).json({ error: 'erro ao salvar a leitura' })
      }
    }
  }
}
