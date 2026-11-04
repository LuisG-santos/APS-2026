import type { SensorBody } from '../contracts.js'
import type { SensoresRepository } from '../repositories/sensores.repository.js'

export function createSensoresService(repository: SensoresRepository) {
  return {
    listar() {
      return repository.listar()
    },
    cadastrar(body: SensorBody) {
      return repository.criar({ nome: body.nome.trim(), tipo: body.tipo })
    }
  }
}

export type SensoresService = ReturnType<typeof createSensoresService>
