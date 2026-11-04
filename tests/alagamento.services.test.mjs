import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Prisma } from '@prisma/client'
import { ErroAlagamento } from '../dist/api-alagamento-inundacao/errors.js'
import { createLeiturasService } from '../dist/api-alagamento-inundacao/services/leituras.service.js'
import { createSensoresService } from '../dist/api-alagamento-inundacao/services/sensores.service.js'
import { createSensoresRepository } from '../dist/api-alagamento-inundacao/repositories/sensores.repository.js'

const medidas = [
  ['NIVEL_CORREGO', 'nivelCorregoCm', 120.5],
  ['PLUVIOMETRO', 'chuvaAcumuladaMm', 35.2],
  ['NIVEL_VIA', 'nivelAguaViaCm', 8]
]
const timestamp = '2026-01-15T06:30:00.123-03:00'
const payload = { sensorId: 7, timestamp, nivelCorregoCm: 120.5 }

function repositorios(sensor = { id: 7, tipo: 'NIVEL_CORREGO' }) {
  const chamadas = { buscas: [], gravacoes: [] }
  const sensores = {
    listar: async () => [],
    criar: async data => data,
    buscarPorId: async id => { chamadas.buscas.push(id); return sensor }
  }
  const leituras = {
    listar: async () => [],
    criar: async data => { chamadas.gravacoes.push(data); return data },
    verificarConexao: async () => {}
  }
  return { chamadas, sensores, leituras }
}
const erroComCodigo = codigo => error => error instanceof ErroAlagamento && error.codigo === codigo

for (const [tipo, campo, valor] of medidas) {
  test(`service de alagamento: ${tipo} preserva medida e instante do sensor`, async () => {
    const repos = repositorios({ id: 7, tipo })
    const service = createLeiturasService(repos.leituras, repos.sensores)
    const result = await service.registrar({ sensorId: 7, timestamp, [campo]: valor })
    assert.deepEqual(repos.chamadas.buscas, [7])
    assert.deepEqual(repos.chamadas.gravacoes, [{ sensorId: 7, timestamp: new Date('2026-01-15T09:30:00.123Z'), [campo]: valor }])
    assert.equal(result, repos.chamadas.gravacoes[0])
  })
}

test('service de alagamento: timestamp invalido impede busca e gravacao', async () => {
  for (const timestamp of ['2026-02-30T12:00:00Z', '2026-01-15T09:30:00', 'invalido']) {
    const repos = repositorios()
    const service = createLeiturasService(repos.leituras, repos.sensores)
    await assert.rejects(service.registrar({ ...payload, timestamp }), erroComCodigo('TIMESTAMP_INVALIDO'))
    assert.deepEqual(repos.chamadas.buscas, [])
    assert.deepEqual(repos.chamadas.gravacoes, [])
  }
})

test('service de alagamento: sensor inexistente impede gravacao', async () => {
  const repos = repositorios(null)
  const service = createLeiturasService(repos.leituras, repos.sensores)
  await assert.rejects(service.registrar(payload), erroComCodigo('SENSOR_NAO_ENCONTRADO'))
  assert.deepEqual(repos.chamadas.buscas, [7])
  assert.deepEqual(repos.chamadas.gravacoes, [])
})

test('service de alagamento: medidas de outros tipos impedem gravacao', async () => {
  for (const [tipo] of medidas) {
    for (const [, campo, valor] of medidas.filter(([outroTipo]) => outroTipo !== tipo)) {
      const repos = repositorios({ id: 7, tipo })
      const service = createLeiturasService(repos.leituras, repos.sensores)
      await assert.rejects(service.registrar({ sensorId: 7, timestamp, [campo]: valor }), erroComCodigo('MEDIDA_INCOMPATIVEL'))
      assert.deepEqual(repos.chamadas.gravacoes, [])
    }
  }
})

test('service de sensores: normaliza nome sem alterar o objeto recebido', async () => {
  const repos = repositorios()
  const gravacoes = []
  repos.sensores.criar = async data => { gravacoes.push(data); return data }
  const body = { nome: '  sensor-01  ', tipo: 'NIVEL_CORREGO' }
  const esperado = { nome: 'sensor-01', tipo: 'NIVEL_CORREGO' }
  assert.deepEqual(await createSensoresService(repos.sensores).cadastrar(body), esperado)
  assert.deepEqual(gravacoes, [esperado])
  assert.equal(body.nome, '  sensor-01  ')
})

test('services: preservam objetos internos nas consultas e propagam falhas', async () => {
  const repos = repositorios()
  const leituras = [{ id: 1, timestamp: new Date(timestamp) }], sensores = [{ id: 7 }]
  repos.leituras.listar = async () => leituras
  repos.sensores.listar = async () => sensores
  const leituraService = createLeiturasService(repos.leituras, repos.sensores)
  const sensorService = createSensoresService(repos.sensores)
  assert.equal(await leituraService.listar(), leituras)
  assert.equal(await sensorService.listar(), sensores)
  const erro = new Error('falha inesperada')
  repos.leituras.criar = async () => { throw erro }
  await assert.rejects(leituraService.registrar(payload), error => error === erro)
  repos.sensores.buscarPorId = async () => { throw erro }
  await assert.rejects(leituraService.registrar(payload), error => error === erro)
  repos.sensores.criar = async () => { throw erro }
  await assert.rejects(sensorService.cadastrar({ nome: 'sensor', tipo: 'NIVEL_VIA' }), error => error === erro)
  const duplicado = new ErroAlagamento('NOME_DUPLICADO', 'ja existe um sensor com esse nome')
  repos.sensores.criar = async () => { throw duplicado }
  await assert.rejects(sensorService.cadastrar({ nome: 'sensor', tipo: 'NIVEL_VIA' }), error => error === duplicado)
})

test('service de leituras: readiness delega ao repository e propaga indisponibilidade', async () => {
  const repos = repositorios()
  let consultas = 0
  repos.leituras.verificarConexao = async () => { consultas++ }
  const service = createLeiturasService(repos.leituras, repos.sensores)
  await service.verificarConexao()
  assert.equal(consultas, 1)
  const erro = new Error('banco indisponivel')
  repos.leituras.verificarConexao = async () => { throw erro }
  await assert.rejects(service.verificarConexao(), error => error === erro)
})

test('repository de sensores: traduz somente P2002 para nome duplicado', async () => {
  const unique = new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: Prisma.prismaVersion.client })
  const falha = new Prisma.PrismaClientKnownRequestError('database', { code: 'P1001', clientVersion: Prisma.prismaVersion.client })
  const prisma = { sensorAlagamento: { create: async () => { throw unique } } }
  const repository = createSensoresRepository(prisma)
  const body = { nome: 'sensor-01', tipo: 'NIVEL_VIA' }
  await assert.rejects(repository.criar(body), erroComCodigo('NOME_DUPLICADO'))
  prisma.sensorAlagamento.create = async () => { throw falha }
  await assert.rejects(repository.criar(body), error => error === falha)
})
