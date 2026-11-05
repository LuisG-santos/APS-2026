import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Prisma } from '@prisma/client'
import { createCacheRedis, consultarSensoresComCache, semCache } from '../dist/shared/cache.js'
import { serializeCreated } from '../dist/shared/serialization.js'
import { createSensoresRepository as alagamento } from '../dist/api-alagamento-inundacao/repositories/sensores.repository.js'
import { createSensoresRepository as qualidadeAr } from '../dist/api-qualidade-do-ar/repositories/sensores.repository.js'
import { createSensoresRepository as transito } from '../dist/api-transito-e-transporte/repositories/sensores.repository.js'

function memoria() {
  const valores = new Map(), prazos = new Map()
  return {
    valores, prazos,
    obter: async chave => valores.get(chave) ?? null,
    salvar: async (chave, valor, segundos) => { valores.set(chave, valor); prazos.set(chave, segundos) },
    invalidar: async chave => { valores.delete(chave) },
    fechar() {}
  }
}

const dominios = [
  { nome: 'alagamento', model: 'sensorAlagamento', repository: alagamento, tipo: 'NIVEL_CORREGO' },
  { nome: 'qualidade-ar', model: 'sensorQualidadeAr', repository: qualidadeAr, tipo: 'MP25', estacao: 'centro' },
  { nome: 'transito', model: 'sensorTransito', repository: transito, tipo: 'RADAR' }
]

for (const dominio of dominios) {
  test(`cache ${dominio.nome}: reutiliza lista, preserva datas e invalida apos cadastro`, async () => {
    const cache = memoria()
    const sensores = [{ id: 1, nome: 'sensor-1', tipo: dominio.tipo,
      ...(dominio.estacao ? { estacao: dominio.estacao } : {}), createdAt: new Date('2026-01-01T00:00:00Z') }]
    let consultas = 0
    const delegate = {
      findMany: async () => { consultas++; return [...sensores] },
      create: async ({ data }) => { const sensor = { ...data, id: 2, createdAt: new Date() }; sensores.push(sensor); return sensor },
      findUnique: async () => sensores[0]
    }
    const repository = dominio.repository({ [dominio.model]: delegate }, cache)
    const primeira = await repository.listar()
    const segunda = await repository.listar()
    assert.equal(consultas, 1)
    assert.deepEqual(segunda, primeira)
    assert.deepEqual(segunda.map(serializeCreated), primeira.map(serializeCreated))
    assert.equal([...cache.prazos.values()][0], 15)
    // O cadastro nao usa a lista em cache para validar o sensor da leitura.
    assert.equal((await repository.buscarPorId(1)).id, 1)
    await repository.criar({ nome: 'sensor-2', tipo: dominio.tipo,
      ...(dominio.estacao ? { estacao: dominio.estacao } : {}) })
    assert.equal(cache.valores.size, 0)
    assert.equal((await repository.listar()).length, 2)
    assert.equal(consultas, 2)
  })

  test(`cache ${dominio.nome}: falha e duplicidade no cadastro preservam erro e cache`, async () => {
    const cache = memoria()
    await cache.salvar(`aps:${dominio.nome}:sensores:v1`, '[]', 15)
    for (const error of [new Error('falha no banco'), new Prisma.PrismaClientKnownRequestError('duplicado', { code: 'P2002', clientVersion: '6.19.3' })]) {
      const repository = dominio.repository({ [dominio.model]: { create: async () => { throw error } } }, cache)
      await assert.rejects(repository.criar({ nome: 'duplicado', tipo: dominio.tipo }),
        error.code === 'P2002' ? e => e.codigo === 'NOME_DUPLICADO' : e => e === error)
      assert.equal(cache.valores.size, 1)
    }
  })
}

test('cache compartilhado isola as listas dos tres dominios', async () => {
  const cache = memoria()
  for (const dominio of dominios) {
    const repository = dominio.repository({ [dominio.model]: { findMany: async () => [{ id: 1, nome: dominio.nome, createdAt: new Date() }] } }, cache)
    assert.equal((await repository.listar())[0].nome, dominio.nome)
  }
  assert.equal(cache.valores.size, 3)
})

test('cache aceita lista vazia e consulta novamente quando a chave expira', async () => {
  const cache = memoria()
  let consultas = 0
  const consultar = async () => { consultas++; return [] }
  await consultarSensoresComCache(cache, 'teste', consultar)
  await consultarSensoresComCache(cache, 'teste', consultar)
  assert.equal(consultas, 1)
  cache.valores.delete('teste') // Simula a expiracao controlada pelo Redis.
  await consultarSensoresComCache(cache, 'teste', consultar)
  assert.equal(consultas, 2)
})

test('cache invalido e descartado e falha do banco continua sendo propagada', async () => {
  for (const valor of ['{invalido', '{}', 'null', '[null]', '[{"createdAt":null}]', '[{"createdAt":"invalida"}]']) {
    const cache = memoria()
    await cache.salvar('teste', valor, 15)
    const sensores = [{ id: 1, createdAt: new Date() }]
    assert.equal(await consultarSensoresComCache(cache, 'teste', async () => sensores), sensores)
  }
  const error = new Error('banco indisponivel'), cache = memoria()
  await assert.rejects(consultarSensoresComCache(cache, 'teste', async () => { throw error }), e => e === error)
  assert.equal(cache.valores.size, 0)
})

test('cache nao configurado mantem consultas diretas e encerramento seguro', async () => {
  assert.equal(createCacheRedis(undefined), semCache)
  assert.equal(createCacheRedis('  '), semCache)
  let consultas = 0
  for (let i = 0; i < 2; i++) await consultarSensoresComCache(semCache, 'teste', async () => { consultas++; return [] })
  assert.equal(consultas, 2)
  semCache.fechar()
})
