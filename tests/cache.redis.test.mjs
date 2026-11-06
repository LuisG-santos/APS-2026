import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { setTimeout as aguardar } from 'node:timers/promises'
import { test } from 'node:test'
import { createClient } from 'redis'
import { createCacheRedis } from '../dist/shared/cache.js'
import { createApp as alagamento } from '../dist/api-alagamento-inundacao/app.js'
import { createApp as qualidadeAr } from '../dist/api-qualidade-do-ar/app.js'
import { createApp as transito } from '../dist/api-transito-e-transporte/app.js'

test('Redis real: GET/POST nas tres APIs, cache entre replicas, expiracao e fallback',
  { skip: !process.env.TEST_REDIS_URL }, async () => {
    const url = process.env.TEST_REDIS_URL
    const admin = createClient({ url, socket: { reconnectStrategy: false } })
    admin.on('error', () => {})
    await admin.connect()
    const cache = createCacheRedis(url), outraReplica = createCacheRedis(url)
    const servidores = [], chaves = []
    try {
      for (const c of [cache, outraReplica]) {
        const chave = `teste-cache-${randomUUID()}`; chaves.push(chave)
        for (let i = 0; i < 80; i++) {
          await c.salvar(chave, 'pronto', 15)
          if (await c.obter(chave) === 'pronto') break
          await aguardar(25)
        }
        assert.equal(await c.obter(chave), 'pronto')
      }
      for (const [createApp, model, dominio, tipo, extra] of [
        [alagamento, 'sensorAlagamento', 'alagamento', 'NIVEL_CORREGO', {}],
        [qualidadeAr, 'sensorQualidadeAr', 'qualidade-ar', 'MP25', { estacao: 'centro' }],
        [transito, 'sensorTransito', 'transito', 'RADAR', {}]
      ]) {
        const chave = `aps:${dominio}:sensores:v1`; chaves.push(chave)
        // Use uma instancia Redis de testes: estas chaves pertencem ao contrato do cache.
        await admin.del(chave)
        const sensores = [{ id: 1, nome: 'sensor-1', tipo, ...extra, createdAt: new Date() }]
        let consultas = 0
        const prisma = { [model]: {
          findMany: async () => { consultas++; return [...sensores] },
          create: async ({ data }) => { const sensor = { ...data, id: 2, createdAt: new Date() }; sensores.push(sensor); return sensor }
        } }
        const urls = []
        for (const c of [cache, outraReplica]) {
          const server = createApp(prisma, c).listen(0, '127.0.0.1'); servidores.push(server)
          await once(server, 'listening')
          urls.push(`http://127.0.0.1:${server.address().port}`)
        }
        const primeira = await (await fetch(`${urls[0]}/get/sensores`)).json()
        const segunda = await (await fetch(`${urls[1]}/get/sensores`)).json()
        assert.deepEqual(segunda, primeira)
        assert.equal(consultas, 1)
        assert.ok(await admin.ttl(chave) > 0)
        const cadastro = await fetch(`${urls[0]}/send/sensor`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nome: 'sensor-2', tipo, ...extra })
        })
        assert.equal(cadastro.status, 201)
        assert.equal(await admin.exists(chave), 0)
        assert.equal((await (await fetch(`${urls[1]}/get/sensores`)).json()).length, 2)
        assert.equal(consultas, 2)
        await admin.pExpire(chave, 30)
        await aguardar(60)
        await fetch(`${urls[0]}/get/sensores`)
        assert.equal(consultas, 3)
      }
      // Um Redis conectado, mas sem responder, tambem precisa liberar a consulta.
      await admin.clientPause(1200, 'ALL')
      const inicio = Date.now()
      assert.equal(await cache.obter(chaves[0]), null)
      assert.ok(Date.now() - inicio < 1100, 'Cache lento deve liberar a API antes da resposta do Redis')
      await admin.ping()
      for (let i = 0; i < 80 && await cache.obter(chaves[0]) === null; i++) await aguardar(25)
      assert.equal(await cache.obter(chaves[0]), 'pronto')
      // Encerrar o transporte simula cache indisponivel sem interromper o banco.
      cache.fechar(); outraReplica.fechar()
      for (const server of servidores) {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/get/sensores`)
        assert.equal(response.status, 200)
        assert.equal((await response.json()).length, 2)
      }
    } finally {
      await Promise.all(servidores.map(server => new Promise(resolve => server.close(resolve))))
      cache.fechar(); outraReplica.fechar()
      if (chaves.length) await admin.del(chaves)
      admin.destroy()
    }
  })
