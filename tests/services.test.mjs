import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ErroAplicacao } from '../dist/shared/errors.js'
import { createLeiturasService as alagamento } from '../dist/api-alagamento-inundacao/services/leituras.service.js'
import { createSensoresService as sensoresAlagamento } from '../dist/api-alagamento-inundacao/services/sensores.service.js'
import { createLeiturasService as qualidadeAr } from '../dist/api-qualidade-do-ar/services/leituras.service.js'
import { createSensoresService as sensoresQualidadeAr } from '../dist/api-qualidade-do-ar/services/sensores.service.js'
import { createLeiturasService as transito } from '../dist/api-transito-e-transporte/services/leituras.service.js'
import { createSensoresService as sensoresTransito } from '../dist/api-transito-e-transporte/services/sensores.service.js'

const apis = [
  { nome: 'alagamento', service: alagamento, sensoresService: sensoresAlagamento, medidas: [
    ['NIVEL_CORREGO', 'nivelCorregoCm', 120.5], ['PLUVIOMETRO', 'chuvaAcumuladaMm', 35.2], ['NIVEL_VIA', 'nivelAguaViaCm', 8]
  ] },
  { nome: 'qualidade-ar', service: qualidadeAr, sensoresService: sensoresQualidadeAr, medidas: [
    ['MP25', 'mp25', 35.2], ['CO', 'co', 0.8], ['NO2', 'no2', 12.4], ['TEMPERATURA', 'temperatura', 27.5]
  ] },
  { nome: 'transito', service: transito, sensoresService: sensoresTransito, medidas: [
    ['RADAR', 'velocidade', 42.5], ['GPS', 'posicao', '-23,-46'], ['OCUPACAO', 'ocupacao', 0.75]
  ] }
]
const timestamp = '2026-01-15T06:30:00.123-03:00'

function erroComCodigo(codigo) {
  return error => error instanceof ErroAplicacao && error.codigo === codigo
}

function repositorios(sensor) {
  const chamadas = { buscas: [], gravacoes: [], conexoes: 0 }
  const leituras = {
    listar: async () => [],
    criar: async data => { chamadas.gravacoes.push(data); return data },
    verificarConexao: async () => { chamadas.conexoes++ }
  }
  const sensores = {
    listar: async () => [],
    criar: async data => data,
    buscarPorId: async id => { chamadas.buscas.push(id); return sensor }
  }
  return { chamadas, leituras, sensores }
}

for (const api of apis) {
  const [tipo, campo, valor] = api.medidas[0]
  const payload = { sensorId: 7, timestamp, [campo]: valor }

  test(`${api.nome}: timestamp invalido impede busca e gravacao`, async () => {
    const repos = repositorios({ id: 7, tipo })
    const service = api.service(repos.leituras, repos.sensores)
    await assert.rejects(service.registrar({ ...payload, timestamp: '2026-02-30T12:00:00Z' }), erroComCodigo('TIMESTAMP_INVALIDO'))
    assert.deepEqual(repos.chamadas.buscas, [])
    assert.deepEqual(repos.chamadas.gravacoes, [])
  })

  test(`${api.nome}: sensor inexistente impede gravacao`, async () => {
    const repos = repositorios(null)
    const service = api.service(repos.leituras, repos.sensores)
    await assert.rejects(service.registrar(payload), erroComCodigo('SENSOR_NAO_ENCONTRADO'))
    assert.deepEqual(repos.chamadas.buscas, [7])
    assert.deepEqual(repos.chamadas.gravacoes, [])
  })

  test(`${api.nome}: medida incompativel impede gravacao`, async () => {
    const repos = repositorios({ id: 7, tipo: api.medidas[1][0] })
    const service = api.service(repos.leituras, repos.sensores)
    await assert.rejects(service.registrar(payload), erroComCodigo('MEDIDA_INCOMPATIVEL'))
    assert.deepEqual(repos.chamadas.gravacoes, [])
  })

  for (const [tipoSensor, field, value] of api.medidas) {
    test(`${api.nome}: ${tipoSensor} grava sua medida e preserva o instante enviado`, async () => {
      const repos = repositorios({ id: 7, tipo: tipoSensor })
      const service = api.service(repos.leituras, repos.sensores)
      const result = await service.registrar({ sensorId: 7, timestamp, [field]: value })
      assert.deepEqual(repos.chamadas.gravacoes, [{ sensorId: 7, timestamp: new Date('2026-01-15T09:30:00.123Z'), [field]: value }])
      assert.equal(result, repos.chamadas.gravacoes[0])
    })
  }

  test(`${api.nome}: normaliza cadastro e repassa nome duplicado`, async () => {
    const repos = repositorios(null)
    const gravacoes = []
    repos.sensores.criar = async data => { gravacoes.push(data); return data }
    const service = api.sensoresService(repos.sensores)
    const input = { nome: '  sensor-01  ', tipo, ...(api.nome === 'qualidade-ar' ? { estacao: '  centro  ' } : {}) }
    const esperado = { nome: 'sensor-01', tipo, ...(api.nome === 'qualidade-ar' ? { estacao: 'centro' } : {}) }
    assert.deepEqual(await service.cadastrar(input), esperado)
    assert.deepEqual(gravacoes, [esperado])
    assert.equal(input.nome, '  sensor-01  ')
    const erro = new ErroAplicacao('NOME_DUPLICADO', 'ja existe um sensor com esse nome')
    repos.sensores.criar = async () => { throw erro }
    await assert.rejects(service.cadastrar(input), error => error === erro)
  })

  test(`${api.nome}: listagens e conexao delegam ao repository sem alterar o resultado`, async () => {
    const repos = repositorios(null)
    const leituras = [{ id: 1 }], sensores = [{ id: 7 }]
    repos.leituras.listar = async () => leituras
    repos.sensores.listar = async () => sensores
    const service = api.service(repos.leituras, repos.sensores)
    assert.equal(await service.listar(), leituras)
    assert.equal(await api.sensoresService(repos.sensores).listar(), sensores)
    await service.verificarConexao()
    assert.equal(repos.chamadas.conexoes, 1)
    const falha = new Error('banco indisponivel')
    repos.leituras.verificarConexao = async () => { throw falha }
    await assert.rejects(service.verificarConexao(), error => error === falha)
    repos.leituras.criar = async () => { throw falha }
    repos.sensores.buscarPorId = async () => ({ id: 7, tipo })
    await assert.rejects(service.registrar(payload), error => error === falha)
  })
}
