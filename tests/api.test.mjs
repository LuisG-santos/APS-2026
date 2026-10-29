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
    route: 'alagamento', model: 'alagamento', sensorModel: 'sensorAlagamento', createApp: alagamento,
    medidas: [['NIVEL', 'nivelCorregoCm', 120.5], ['CHUVA', 'chuvaAcumuladaMm', 35.2]], extra: {}
  },
  {
    route: 'qualidade-ar', model: 'qualidadeAr', sensorModel: 'sensorQualidadeAr', createApp: qualidadeAr,
    medidas: [['MP25', 'mp25', 35.2], ['CO', 'co', 0.8], ['NO3', 'no3', 12.4], ['TEMPERATURA', 'temperatura', 27.5]],
    extra: { estacao: 'teste-estacao' }
  },
  {
    route: 'transito', model: 'transito', sensorModel: 'sensorTransito', createApp: transito,
    medidas: [['RADAR', 'velocidade', 42.5], ['GPS', 'posicao', '-23.5505,-46.6333'], ['OCUPACAO', 'ocupacao', 0.75]], extra: {}
  }
].map(api => ({
  ...api,
  prisma: new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL } } }),
  ids: [], sensorIds: [], sensores: {}
}))

const prefix = `teste-${randomUUID()}`
const timestamp = '2026-01-15T09:30:00.123Z'

async function cadastrarSensor(api, payload) {
  const response = await fetch(`${api.url}/send/sensor`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  })
  const body = await response.json()
  if (response.status === 201) api.sensorIds.push(body.id)
  return { status: response.status, body }
}

async function send(api, payload) {
  const response = await fetch(`${api.url}/send/${api.route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  })
  const body = await response.json()
  if (response.status === 201) api.ids.push(body.id)
  return { status: response.status, body }
}

before(async () => {
  for (const api of apis) {
    await api.prisma.$connect()
    api.server = api.createApp(api.prisma).listen(0, '127.0.0.1')
    await once(api.server, 'listening')
    api.url = `http://127.0.0.1:${api.server.address().port}`
    for (const [tipo] of api.medidas) {
      const { status, body } = await cadastrarSensor(api, { nome: `${prefix}-${tipo}`, tipo })
      assert.equal(status, 201)
      api.sensores[tipo] = body
    }
    const [tipo, field, value] = api.medidas[0]
    api.payload = { ...api.extra, sensorId: api.sensores[tipo].id, timestamp, [field]: value }
  }
})

after(async () => {
  for (const api of apis) {
    if (api.server) {
      await new Promise((resolve, reject) => api.server.close(error => error ? reject(error) : resolve()))
    }
    try {
      await api.prisma[api.model].deleteMany({ where: { id: { in: api.ids } } })
      await api.prisma[api.sensorModel].deleteMany({ where: { id: { in: api.sensorIds } } })
    } finally {
      await api.prisma.$disconnect()
    }
  }
})

for (const api of apis) {
  test(`${api.route}: cadastra nome, tipo e ID e lista os sensores`, async () => {
    const [tipo] = api.medidas[0]
    const { status, body } = await cadastrarSensor(api, { nome: `  ${prefix}-${tipo}-extra  `, tipo })
    assert.equal(status, 201)
    assert.equal(body.nome, `${prefix}-${tipo}-extra`)
    assert.equal(body.tipo, tipo)
    assert.equal(typeof body.createdAt, 'string')
    const stored = await api.prisma[api.sensorModel].findUniqueOrThrow({ where: { id: body.id } })
    assert.equal(stored.nome, body.nome)
    assert.equal(stored.createdAt.toISOString(), body.createdAt)
    const response = await fetch(`${api.url}/get/sensores`)
    assert.equal(response.status, 200)
    assert.ok((await response.json()).some(sensor => sensor.id === body.id && sensor.nome === body.nome && sensor.tipo === tipo))
  })

  test(`${api.route}: rejeita cadastro com nome, tipo ou formato incorreto`, async () => {
    const count = await api.prisma[api.sensorModel].count()
    const [tipo] = api.medidas[0]
    for (const payload of [{}, [], [{ nome: 'sensor', tipo }], { nome: '', tipo }, { nome: '   ', tipo },
      { nome: 123, tipo }, { nome: `${prefix}-invalido` }, { nome: `${prefix}-invalido`, tipo: 'CAMERA' },
      { nome: `${prefix}-invalido`, tipo: [tipo] }, { nome: `${prefix}-invalido`, tipo: {} }]) {
      assert.equal((await cadastrarSensor(api, payload)).status, 400)
    }
    assert.equal(await api.prisma[api.sensorModel].count(), count)
  })

  test(`${api.route}: nome duplicado retorna 409`, async () => {
    const [tipo] = api.medidas[0]
    assert.equal((await cadastrarSensor(api, { nome: api.sensores[tipo].nome, tipo })).status, 409)
  })

  test(`${api.route}: exige sensor cadastrado com ID valido`, async () => {
    const count = await api.prisma[api.model].count()
    for (const sensorId of [undefined, null, 0, -1, 1.5, '1', 2147483648]) {
      assert.equal((await send(api, { ...api.payload, sensorId })).status, 400)
    }
    assert.equal((await send(api, { ...api.payload, sensorId: 2147483647 })).status, 404)
    assert.equal(await api.prisma[api.model].count(), count)
  })

  test(`${api.route}: cada tipo grava sua unica medida e identifica o sensor na consulta`, async () => {
    for (const [tipo, field, value] of api.medidas) {
      const sensor = api.sensores[tipo]
      const { status, body } = await send(api, { ...api.extra, sensorId: sensor.id, timestamp, [field]: value })
      assert.equal(status, 201)
      assert.equal(body.sensorId, sensor.id)
      assert.deepEqual(body.sensor, sensor)
      for (const [, measure] of api.medidas) {
        assert.equal(body[measure], measure === field ? value : null)
      }
      for (const [key, expected] of Object.entries(api.extra)) assert.equal(body[key], expected)
      const stored = await api.prisma[api.model].findUniqueOrThrow({ where: { id: body.id }, include: { sensor: true } })
      assert.equal(stored[field], value)
      assert.equal(stored.sensor.id, sensor.id)
      const response = await fetch(`${api.url}/get/${api.route}`)
      assert.equal(response.status, 200)
      const found = (await response.json()).find(reading => reading.id === body.id)
      assert.deepEqual(found, body)
    }
  })

  test(`${api.route}: rejeita medida ausente, misturada ou de outro tipo de sensor`, async () => {
    const count = await api.prisma[api.model].count()
    for (const [index, [tipo, field, value]] of api.medidas.entries()) {
      const [, otherField, otherValue] = api.medidas[(index + 1) % api.medidas.length]
      for (const medidas of [{}, { [otherField]: otherValue }, { [field]: value, [otherField]: otherValue },
        { [field]: value, [otherField]: null }]) {
        assert.equal((await send(api, { ...api.extra, sensorId: api.sensores[tipo].id, timestamp, ...medidas })).status, 400)
      }
    }
    assert.equal(await api.prisma[api.model].count(), count)
  })

  test(`${api.route}: banco exige uma medida e impede sensor inexistente ou exclusao de sensor em uso`, async () => {
    const data = { ...api.payload, timestamp: new Date(timestamp) }
    const [, otherField, otherValue] = api.medidas[1]
    const [, field] = api.medidas[0]
    await assert.rejects(api.prisma[api.model].create({ data: { ...data, [field]: undefined } }))
    await assert.rejects(api.prisma[api.model].create({ data: { ...data, [otherField]: otherValue } }))
    await assert.rejects(api.prisma[api.model].create({ data: { ...data, sensorId: 2147483647 } }))
    const { status } = await send(api, api.payload)
    assert.equal(status, 201)
    await assert.rejects(api.prisma[api.sensorModel].delete({ where: { id: api.payload.sensorId } }))
  })

  test(`${api.route}: preserva timestamp do sensor separado de createdAt`, async () => {
    const { status, body } = await send(api, api.payload)
    assert.equal(status, 201)
    assert.equal(body.timestamp, timestamp)
    const stored = await api.prisma[api.model].findUniqueOrThrow({ where: { id: body.id } })
    assert.equal(stored.timestamp.toISOString(), timestamp)
    assert.notEqual(stored.timestamp.getTime(), stored.createdAt.getTime())
    assert.equal(body.createdAt, stored.createdAt.toISOString())
    if (api.model === 'transito') assert.equal(Object.hasOwn(body, 'veiculo'), false)
  })

  test(`${api.route}: preserva o instante de timestamp com fuso horario`, async () => {
    const { status, body } = await send(api, { ...api.payload, timestamp: '2026-01-15T06:30:00.123-03:00' })
    assert.equal(status, 201)
    assert.equal(body.timestamp, timestamp)
  })

  test(`${api.route}: rejeita timestamp ausente ou invalido sem gravar`, async () => {
    const count = await api.prisma[api.model].count()
    for (const timestamp of [undefined, null, '', 'invalido', '2026-02-30T12:00:00Z',
      '2026-01-15T09:30:00', '2026-01-15', '2026-01-15T24:00:00Z']) {
      assert.equal((await send(api, { ...api.payload, timestamp })).status, 400, `timestamp: ${String(timestamp)}`)
    }
    assert.equal(await api.prisma[api.model].count(), count)
  })

  test(`${api.route}: liveness e readiness respondem com o banco conectado`, async () => {
    assert.equal((await fetch(`${api.url}/health/live`)).status, 200)
    assert.equal((await fetch(`${api.url}/health/ready`)).status, 200)
  })

  test(`${api.route}: rejeita JSON com formato ou tipos incorretos sem gravar`, async () => {
    const count = await api.prisma[api.model].count()
    assert.equal((await send(api, [api.payload])).status, 400)
    assert.equal((await send(api, { ...api.payload, timestamp: 123 })).status, 400)
    for (const [tipo, field] of api.medidas) {
      const invalidos = field === 'posicao' ? [12.5, null, true, {}, '', '   '] : ['12.5', null, true, {}]
      for (const value of invalidos) {
        assert.equal((await send(api, { ...api.extra, sensorId: api.sensores[tipo].id, timestamp, [field]: value })).status, 400)
      }
    }
    assert.equal(await api.prisma[api.model].count(), count)
  })
}

test('qualidade-ar: estacao continua obrigatoria como local da leitura', async () => {
  const api = apis[1]
  const count = await api.prisma.qualidadeAr.count()
  for (const estacao of [undefined, null, '', '   ', 123, []]) {
    assert.equal((await send(api, { ...api.payload, estacao })).status, 400)
  }
  assert.equal(await api.prisma.qualidadeAr.count(), count)
})

test('as tres APIs usam o mesmo banco com tres tabelas de leituras e tres de sensores', async () => {
  const names = await Promise.all(apis.map(async api => {
    const [row] = await api.prisma.$queryRaw`SELECT current_database() AS name`
    return row.name
  }))
  assert.equal(new Set(names).size, 1)
  const tables = ['Alagamento', 'QualidadeAr', 'Transito', 'SensorAlagamento', 'SensorQualidadeAr', 'SensorTransito']
  const columns = await apis[0].prisma.$queryRaw`
    SELECT table_name, column_name, is_nullable, column_default
    FROM information_schema.columns WHERE table_schema = 'public'
  `
  for (const table of tables) assert.ok(columns.some(column => column.table_name === table))
  assert.equal(columns.some(column => column.table_name === 'Transito' && column.column_name === 'veiculo'), false)
  for (const table of tables.slice(0, 3)) {
    const timestamp = columns.find(column => column.table_name === table && column.column_name === 'timestamp')
    assert.equal(timestamp.is_nullable, 'NO')
    assert.equal(timestamp.column_default, null)
    assert.equal(columns.find(column => column.table_name === table && column.column_name === 'sensorId').is_nullable, 'NO')
    assert.equal(columns.some(column => column.table_name === table && column.column_name === 'sensor'), false)
  }
})
