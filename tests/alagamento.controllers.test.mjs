import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ErroAlagamento } from '../dist/api-alagamento-inundacao/errors.js'
import { createSensoresController } from '../dist/api-alagamento-inundacao/controllers/sensores.controller.js'
import { createLeiturasController } from '../dist/api-alagamento-inundacao/controllers/leituras.controller.js'

function resposta() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this }
  }
}
const sensor = { id: 7, nome: 'sensor-01', tipo: 'NIVEL_CORREGO', createdAt: new Date('2026-01-01T00:00:00Z') }
const leitura = { id: 1, sensorId: 7, sensor, timestamp: new Date('2026-01-15T09:30:00Z'), nivelCorregoCm: 120.5,
  chuvaAcumuladaMm: null, nivelAguaViaCm: null, createdAt: new Date('2026-01-15T09:31:00Z') }
const payload = { sensorId: 7, timestamp: '2026-01-15T09:30:00Z', nivelCorregoCm: 120.5 }

test('controllers: serializam datas do sensor e da leitura sem alterar objetos internos', async () => {
  const sensores = createSensoresController({ listar: async () => [sensor], cadastrar: async () => sensor })
  const leituras = createLeiturasController({ listar: async () => [leitura], registrar: async () => leitura })
  const sensorResponse = resposta(), leituraResponse = resposta(), listaResponse = resposta()
  await sensores.cadastrar({ body: { nome: sensor.nome, tipo: sensor.tipo } }, sensorResponse)
  assert.equal(sensorResponse.statusCode, 201)
  assert.equal(sensorResponse.body.createdAt, sensor.createdAt.toISOString())
  await leituras.registrar({ body: payload }, leituraResponse)
  assert.equal(leituraResponse.statusCode, 201)
  assert.equal(leituraResponse.body.timestamp, leitura.timestamp.toISOString())
  assert.equal(leituraResponse.body.sensor.createdAt, sensor.createdAt.toISOString())
  assert.equal(leituraResponse.body.chuvaAcumuladaMm, null)
  assert.equal(leituraResponse.body.nivelAguaViaCm, null)
  await leituras.listar({}, listaResponse)
  assert.deepEqual(listaResponse.body, [leituraResponse.body])
  assert.ok(leitura.timestamp instanceof Date)
  assert.ok(sensor.createdAt instanceof Date)
})

test('controllers: JSON invalido retorna 400 sem chamar o service', async () => {
  let chamadas = 0
  const sensores = createSensoresController({ cadastrar: async () => { chamadas++ } })
  const leituras = createLeiturasController({ registrar: async () => { chamadas++ } })
  const resSensor = resposta(), resLeitura = resposta()
  await sensores.cadastrar({ body: { nome: '', tipo: 'NIVEL_VIA' } }, resSensor)
  await leituras.registrar({ body: { ...payload, chuvaAcumuladaMm: 35 } }, resLeitura)
  assert.equal(resSensor.statusCode, 400)
  assert.equal(resLeitura.statusCode, 400)
  assert.equal(chamadas, 0)
})

for (const [codigo, status] of [['NOME_DUPLICADO', 409], ['TIMESTAMP_INVALIDO', 400], ['SENSOR_NAO_ENCONTRADO', 404], ['MEDIDA_INCOMPATIVEL', 400]]) {
  test(`controllers: ${codigo} mantem status ${status} e mensagem`, async () => {
    const erro = new ErroAlagamento(codigo, 'mensagem original')
    const res = resposta()
    if (codigo === 'NOME_DUPLICADO') {
      await createSensoresController({ cadastrar: async () => { throw erro } }).cadastrar({ body: { nome: sensor.nome, tipo: sensor.tipo } }, res)
    } else {
      await createLeiturasController({ registrar: async () => { throw erro } }).registrar({ body: payload }, res)
    }
    assert.equal(res.statusCode, status)
    assert.deepEqual(res.body, { error: erro.message })
  })
}

test('controllers: erros inesperados mantem respostas 500 e sao registrados', async t => {
  const erro = new Error('falha interna')
  const log = t.mock.method(console, 'error', () => {})
  const falhar = async () => { throw erro }
  const sensores = createSensoresController({ listar: falhar, cadastrar: falhar })
  const leituras = createLeiturasController({ listar: falhar, registrar: falhar })
  for (const [handler, body, mensagem] of [
    [sensores.listar, undefined, 'erro ao consultar os sensores'],
    [sensores.cadastrar, { nome: sensor.nome, tipo: sensor.tipo }, 'erro ao cadastrar o sensor'],
    [leituras.listar, undefined, 'erro ao consultar as leituras'],
    [leituras.registrar, payload, 'erro ao salvar a leitura']
  ]) {
    const res = resposta()
    await handler({ body }, res)
    assert.equal(res.statusCode, 500)
    assert.deepEqual(res.body, { error: mensagem })
  }
  assert.equal(log.mock.calls.length, 4)
})
