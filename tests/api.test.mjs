import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
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
    sensorModel: 'sensorAlagamento', measures: [['NIVEL_CORREGO', 'nivelCorregoCm', 120.5], ['PLUVIOMETRO', 'chuvaAcumuladaMm', 35.2], ['NIVEL_VIA', 'nivelAguaViaCm', 8]],
    payload: { nivelCorregoCm: 120.5 }
  },
  {
    route: 'qualidade-ar', model: 'qualidadeAr', createApp: qualidadeAr,
    sensorModel: 'sensorQualidadeAr', measures: [['MP25', 'mp25', 35.2], ['CO', 'co', 0.8], ['NO2', 'no2', 12.4], ['TEMPERATURA', 'temperatura', 27.5]],
    payload: { mp25: 35.2 }
  },
  {
    route: 'transito', model: 'transito', createApp: transito,
    payload: { velocidade: 42.5 }
  }
].map(api => ({
  ...api,
  prisma: new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL } } }),
  ids: []
}))

const sensorIds = []
const sensores = {}
const prefix = `teste-${randomUUID()}`

async function cadastrarSensor(payload) {
  const response = await fetch(`${apis[2].url}/send/sensor`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  })
  const body = await response.json()
  if (response.status === 201) sensorIds.push(body.id)
  return { status: response.status, body }
}

before(async () => {
  for (const api of apis) {
    await api.prisma.$connect()
    api.server = api.createApp(api.prisma).listen(0, '127.0.0.1')
    await once(api.server, 'listening')
    api.url = `http://127.0.0.1:${api.server.address().port}`
  }
  for (const tipo of ['RADAR', 'GPS', 'OCUPACAO']) {
    const { status, body } = await cadastrarSensor({ nome: `${prefix}-${tipo}`, tipo })
    assert.equal(status, 201)
    sensores[tipo] = body
  }
  apis[2].payload.sensorId = sensores.RADAR.id
  for (const api of apis.slice(0, 2)) {
    api.sensorIds = []
    api.sensores = {}
    for (const [tipo] of api.measures) {
      const result = await register(api, { nome: `${prefix}-${tipo}`, tipo, ...(api.model === 'qualidadeAr' ? { estacao: 'centro' } : {}) })
      assert.equal(result.status, 201)
      api.sensores[tipo] = result.body
    }
    api.payload.sensorId = api.sensores[api.measures[0][0]].id
  }
})

after(async () => {
  for (const api of apis) {
    if (api.server) {
      await new Promise((resolve, reject) => api.server.close(error => error ? reject(error) : resolve()))
    }
    try {
      await api.prisma[api.model].deleteMany({ where: { id: { in: api.ids } } })
      if (api.sensorModel) await api.prisma[api.sensorModel].deleteMany({ where: { id: { in: api.sensorIds ?? [] } } })
      if (api.model === 'transito') {
        await api.prisma.sensorTransito.deleteMany({ where: { id: { in: sensorIds } } })
      }
    } finally {
      await api.prisma.$disconnect()
    }
  }
})

test('cadastro de sensores: nome, tipo e ID sao persistidos e listados', async () => {
  const { status, body } = await cadastrarSensor({ nome: `  ${prefix}-radar-extra  `, tipo: 'RADAR' })
  assert.equal(status, 201)
  assert.equal(body.nome, `${prefix}-radar-extra`)
  assert.equal(body.tipo, 'RADAR')
  const stored = await apis[2].prisma.sensorTransito.findUniqueOrThrow({ where: { id: body.id } })
  assert.equal(stored.nome, body.nome)
  const response = await fetch(`${apis[2].url}/get/sensores`)
  assert.equal(response.status, 200)
  assert.ok((await response.json()).some(sensor => sensor.id === body.id && sensor.nome === body.nome))
})

test('cadastro de sensores: rejeita nome vazio e tipos desconhecidos', async () => {
  const count = await apis[2].prisma.sensorTransito.count()
  for (const payload of [{}, { nome: '', tipo: 'RADAR' }, { nome: '   ', tipo: 'GPS' },
    { nome: `${prefix}-invalido` }, { nome: `${prefix}-invalido`, tipo: 'CAMERA' }]) {
    assert.equal((await cadastrarSensor(payload)).status, 400)
  }
  assert.equal(await apis[2].prisma.sensorTransito.count(), count)
})

test('cadastro de sensores: nome duplicado retorna 409', async () => {
  const response = await cadastrarSensor({ nome: sensores.RADAR.nome, tipo: 'RADAR' })
  assert.equal(response.status, 409)
})

test('transito: exige sensor cadastrado com ID valido', async () => {
  const api = apis[2]
  const count = await api.prisma.transito.count()
  for (const sensorId of [undefined, null, 0, -1, 1.5, '1', 2147483648]) {
    assert.equal((await send(api, { sensorId, timestamp: '2026-01-15T09:30:00Z', velocidade: 42.5 })).status, 400)
  }
  const result = await send(api, { sensorId: 2147483647, timestamp: '2026-01-15T09:30:00Z', velocidade: 42.5 })
  assert.equal(result.status, 404)
  assert.equal(await api.prisma.transito.count(), count)
})

test('transito: cada sensor grava somente a sua medida e aparece na consulta', async () => {
  const api = apis[2]
  for (const [tipo, field, value] of [['RADAR', 'velocidade', 42.5], ['GPS', 'posicao', '-23.5505,-46.6333'],
    ['OCUPACAO', 'ocupacao', 0.75]]) {
    const { status, body } = await send(api, {
      sensorId: sensores[tipo].id, timestamp: '2026-01-15T09:30:00.123Z', [field]: value
    })
    assert.equal(status, 201)
    assert.equal(body.sensorId, sensores[tipo].id)
    assert.equal(body.sensor.nome, sensores[tipo].nome)
    assert.equal(body.sensor.tipo, tipo)
    for (const measure of ['velocidade', 'posicao', 'ocupacao']) {
      assert.equal(body[measure], measure === field ? value : null)
    }
    const stored = await api.prisma.transito.findUniqueOrThrow({ where: { id: body.id }, include: { sensor: true } })
    assert.equal(stored[field], value)
    assert.equal(stored.sensor.id, sensores[tipo].id)
    const readings = await (await fetch(`${api.url}/get/transito`)).json()
    assert.equal(readings.find(reading => reading.id === body.id).sensor.nome, sensores[tipo].nome)
  }
})

test('transito: rejeita medidas misturadas, ausentes ou incompativeis com o sensor', async () => {
  const api = apis[2]
  const count = await api.prisma.transito.count()
  for (const [tipo, medidas] of [['RADAR', {}], ['RADAR', { posicao: '-23,-46' }],
    ['RADAR', { velocidade: 42.5, posicao: '-23,-46', ocupacao: 0.75 }],
    ['RADAR', { velocidade: '42.5' }], ['RADAR', { velocidade: 42.5, ocupacao: null }],
    ['GPS', { velocidade: 42.5 }], ['GPS', { posicao: '   ' }],
    ['OCUPACAO', { posicao: '-23,-46' }], ['OCUPACAO', { ocupacao: null }]]) {
    const result = await send(api, { sensorId: sensores[tipo].id, timestamp: '2026-01-15T09:30:00Z', ...medidas })
    assert.equal(result.status, 400)
  }
  assert.equal(await api.prisma.transito.count(), count)
})

test('transito: banco impede leitura com duas medidas ou sem sensor existente', async () => {
  const prisma = apis[2].prisma
  await assert.rejects(prisma.transito.create({ data: {
    sensorId: sensores.RADAR.id, timestamp: new Date('2026-01-15T09:30:00Z'), velocidade: 42.5, ocupacao: 0.75
  } }))
  await assert.rejects(prisma.transito.create({ data: {
    sensorId: 2147483647, timestamp: new Date('2026-01-15T09:30:00Z'), velocidade: 42.5
  } }))
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
    assert.equal(stored.sensorId, api.payload.sensorId)
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

  test(`${api.route}: rejeita JSON com formato ou tipos incorretos sem gravar`, async () => {
    const count = await api.prisma[api.model].count()
    const field = api.model === 'alagamento' ? 'nivelCorregoCm' : api.model === 'qualidadeAr' ? 'mp25' : 'velocidade'
    for (const payload of [[api.payload], { ...api.payload, timestamp: 123 },
      ...['12.5', null, true, {}].map(value => ({ ...api.payload, timestamp: '2026-01-15T09:30:00Z', [field]: value }))]) {
      assert.equal((await send(api, payload)).status, 400)
    }
    assert.equal(await api.prisma[api.model].count(), count)
  })
}

test('cadastro de sensores: rejeita corpos e tipos incorretos em tempo de execucao', async () => {
  const count = await apis[2].prisma.sensorTransito.count()
  for (const payload of [[], [{ nome: 'radar', tipo: 'RADAR' }], { nome: 123, tipo: 'RADAR' },
    { nome: `${prefix}-tipo-invalido`, tipo: ['RADAR'] }, { nome: `${prefix}-tipo-invalido`, tipo: {} }]) {
    assert.equal((await cadastrarSensor(payload)).status, 400)
  }
  assert.equal(await apis[2].prisma.sensorTransito.count(), count)
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
  assert.equal(columns.find(column => column.table_name === 'QualidadeAr' && column.column_name === 'sensorId').is_nullable, 'NO')
  for (const table of ['Alagamento', 'QualidadeAr', 'Transito']) {
    const timestamp = columns.find(column => column.table_name === table && column.column_name === 'timestamp')
    assert.equal(timestamp.is_nullable, 'NO')
    assert.equal(timestamp.column_default, null)
  }
})

async function register(api, payload) {
  const response = await fetch(`${api.url}/send/sensor`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  })
  const body = await response.json()
  if (response.status === 201) api.sensorIds.push(body.id)
  return { status: response.status, body }
}

for (const api of apis.slice(0, 2)) {
  test(`${api.route}: cadastro, duplicidade e validacao dos sensores`, async () => {
    const sensor = api.sensores[api.measures[0][0]]
    assert.equal((await register(api, { nome: sensor.nome, tipo: sensor.tipo, estacao: 'centro' })).status, 409)
    for (const payload of [[], {}, { nome: ' ', tipo: sensor.tipo, estacao: 'centro' },
      { nome: `${prefix}-invalid`, tipo: 'DESCONHECIDO', estacao: 'centro' },
      ...(api.model === 'qualidadeAr' ? [{ nome: `${prefix}-sem-estacao`, tipo: sensor.tipo },
        { nome: `${prefix}-estacao-vazia`, tipo: sensor.tipo, estacao: ' ' }] : [])]) {
      assert.equal((await register(api, payload)).status, 400)
    }
    const response = await fetch(`${api.url}/get/sensores`)
    assert.equal(response.status, 200)
    assert.ok((await response.json()).some(item => item.id === sensor.id))
  })

  test(`${api.route}: todas as medidas sao persistidas e consultadas separadamente`, async () => {
    for (const [tipo, field, value] of api.measures) {
      const sensor = api.sensores[tipo]
      const result = await send(api, { sensorId: sensor.id, timestamp: '2026-01-15T09:30:00Z', [field]: value })
      assert.equal(result.status, 201)
      assert.equal(result.body.sensor.tipo, tipo)
      assert.equal(typeof result.body.sensor.createdAt, 'string')
      if (api.model === 'qualidadeAr') assert.equal(result.body.sensor.estacao, 'centro')
      for (const [, measure] of api.measures) assert.equal(result.body[measure], measure === field ? value : null)
      const rows = await (await fetch(`${api.url}/get/${api.route}`)).json()
      assert.deepEqual(rows.find(row => row.id === result.body.id), result.body)
      const stored = await api.prisma[api.model].findUniqueOrThrow({ where: { id: result.body.id } })
      assert.equal(stored[field], value)
    }
  })

  test(`${api.route}: rejeita sensor invalido e medidas ausentes, misturadas ou incompativeis`, async () => {
    const timestamp = '2026-01-15T09:30:00Z'
    const sensorId = api.payload.sensorId
    const first = api.measures[0][1], second = api.measures[1][1]
    const count = await api.prisma[api.model].count()
    for (const id of [undefined, null, 0, -1, 1.5, '1', 2147483648]) {
      assert.equal((await send(api, { ...api.payload, sensorId: id, timestamp })).status, 400)
    }
    assert.equal((await send(api, { ...api.payload, sensorId: 2147483647, timestamp })).status, 404)
    for (const medidas of [{}, { [second]: 1 }, { [first]: 1, [second]: 2 }, { [first]: 1, [second]: null }]) {
      assert.equal((await send(api, { sensorId, timestamp, ...medidas })).status, 400)
    }
    assert.equal(await api.prisma[api.model].count(), count)
  })

  test(`${api.route}: banco exige uma medida, chave estrangeira e preserva sensores em uso`, async () => {
    const timestamp = new Date('2026-01-15T09:30:00Z')
    const first = api.measures[0][1], second = api.measures[1][1]
    for (const data of [{ sensorId: api.payload.sensorId, timestamp },
      { sensorId: api.payload.sensorId, timestamp, [first]: 1, [second]: 2 },
      { sensorId: 2147483647, timestamp, [first]: 1 }]) {
      await assert.rejects(api.prisma[api.model].create({ data }))
    }
    await send(api, { ...api.payload, timestamp: timestamp.toISOString() })
    await assert.rejects(api.prisma[api.sensorModel].delete({ where: { id: api.payload.sensorId } }))
  })
}
