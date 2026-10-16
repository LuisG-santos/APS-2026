import assert from 'node:assert/strict'
import { once } from 'node:events'
import { after, before, test } from 'node:test'
import { PrismaClient } from '@prisma/client'
import { createApp as alagamento } from '../dist/api-alagamento-inundacao/app.js'
import { createApp as qualidadeAr } from '../dist/api-qualidade-do-ar/app.js'
import { createApp as transito } from '../dist/api-transito-e-transporte/app.js'

if (!process.env.TEST_DATABASE_URL) {
  throw new Error('Defina TEST_DATABASE_URL para um banco de testes com as migracoes aplicadas.')
}

const apis = [
  {
    route: 'alagamento', model: 'alagamento', createApp: alagamento,
    payload: { sensor: 'teste-alagamento', nivelCorregoCm: 120.5, chuvaAcumuladaMm: 35.2 }
  },
  {
    route: 'qualidade-ar', model: 'qualidadeAr', createApp: qualidadeAr,
    payload: { sensor: 'teste-ar', estacao: 'teste-estacao', mp25: 35.2, co: 0.8, no3: 12.4, temperatura: 27.5 }
  },
  {
    route: 'transito', model: 'transito', createApp: transito,
    payload: { posicao: '-23.5505,-46.6333', velocidade: 42.5, ocupacao: 0.75 }
  }
].map(api => ({
  ...api,
  prisma: new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL } } }),
  ids: []
}))

before(async () => {
  for (const api of apis) {
    await api.prisma.$connect()
    api.server = api.createApp(api.prisma).listen(0, '127.0.0.1')
    await once(api.server, 'listening')
    api.url = `http://127.0.0.1:${api.server.address().port}`
  }
})

after(async () => {
  for (const api of apis) {
    if (api.server) {
      await new Promise((resolve, reject) => api.server.close(error => error ? reject(error) : resolve()))
    }
    try {
      await api.prisma[api.model].deleteMany({ where: { id: { in: api.ids } } })
    } finally {
      await api.prisma.$disconnect()
    }
  }
})

async function send(api, payload) {
  const response = await fetch(`${api.url}/send/${api.route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  })
  const body = await response.json()
  if (response.status === 201) api.ids.push(body.id)
  return { status: response.status, body }
}

for (const api of apis) {
  test(`${api.route}: grava e retorna o timestamp enviado pelo sensor`, async () => {
    const timestamp = '2026-01-15T09:30:00.123Z'
    const { status, body } = await send(api, { ...api.payload, timestamp })
    assert.equal(status, 201)
    assert.equal(body.timestamp, timestamp)
    const stored = await api.prisma[api.model].findUniqueOrThrow({ where: { id: body.id } })
    assert.equal(stored.timestamp.toISOString(), timestamp)
    assert.notEqual(stored.timestamp.getTime(), stored.createdAt.getTime())
    const readings = await (await fetch(`${api.url}/get/${api.route}`)).json()
    assert.equal(readings.find(reading => reading.id === body.id).timestamp, timestamp)
    if (api.model === 'qualidadeAr') assert.equal(stored.sensor, api.payload.sensor)
    if (api.model === 'transito') assert.equal(Object.hasOwn(body, 'veiculo'), false)
  })

  test(`${api.route}: preserva o instante de um timestamp com fuso horario`, async () => {
    const { status, body } = await send(api, { ...api.payload, timestamp: '2026-01-15T06:30:00.123-03:00' })
    assert.equal(status, 201)
    assert.equal(body.timestamp, '2026-01-15T09:30:00.123Z')
  })

  test(`${api.route}: rejeita timestamp ausente ou invalido sem gravar uma leitura`, async () => {
    const count = await api.prisma[api.model].count()
    for (const timestamp of [undefined, null, '', 'invalido', '2026-02-30T12:00:00Z',
      '2026-01-15T09:30:00', '2026-01-15', '2026-01-15T24:00:00Z']) {
      const { status } = await send(api, { ...api.payload, timestamp })
      assert.equal(status, 400, `timestamp: ${String(timestamp)}`)
    }
    assert.equal(await api.prisma[api.model].count(), count)
  })

  test(`${api.route}: liveness e readiness respondem com o banco conectado`, async () => {
    assert.equal((await fetch(`${api.url}/health/live`)).status, 200)
    assert.equal((await fetch(`${api.url}/health/ready`)).status, 200)
  })
}

test('qualidade-ar: sensor e obrigatorio e nao aceita identificacao vazia', async () => {
  const api = apis[1]
  for (const sensor of [undefined, null, '', '   ']) {
    const { status } = await send(api, { ...api.payload, sensor, timestamp: '2026-01-15T09:30:00Z' })
    assert.equal(status, 400)
  }
})

test('as tres conexoes usam o mesmo banco com as tres tabelas', async () => {
  const names = await Promise.all(apis.map(async api => {
    const [row] = await api.prisma.$queryRaw`SELECT current_database() AS name`
    return row.name
  }))
  assert.equal(new Set(names).size, 1)
  const columns = await apis[0].prisma.$queryRaw`
    SELECT table_name, column_name, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name IN ('Alagamento', 'QualidadeAr', 'Transito')
  `
  assert.equal(columns.some(column => column.table_name === 'Transito' && column.column_name === 'veiculo'), false)
  assert.equal(columns.find(column => column.table_name === 'QualidadeAr' && column.column_name === 'sensor').is_nullable, 'NO')
  for (const table of ['Alagamento', 'QualidadeAr', 'Transito']) {
    const timestamp = columns.find(column => column.table_name === table && column.column_name === 'timestamp')
    assert.equal(timestamp.is_nullable, 'NO')
    assert.equal(timestamp.column_default, null)
  }
})