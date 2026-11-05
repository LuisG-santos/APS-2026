import assert from 'node:assert/strict'
import { test } from 'node:test'
import { carregarLimites, createAlertasService, lerEvento } from '../dist/shared/alertas/alertas.service.js'
import { createAlertasController } from '../dist/shared/alertas/alertas.controller.js'

const limites = carregarLimites({})
const evento = { dominio: 'ALAGAMENTO', leituraId: 1, sensorId: 2, valor: 151, timestamp: new Date('2026-01-15T09:30:00Z') }

for (const [dominio, limite] of Object.entries(limites)) {
  test(`alertas ${dominio}: somente valor estritamente acima do limite gera alerta`, async () => {
    const salvos = []
    const service = createAlertasService({ salvar: async (data, limite) => { salvos.push({ ...data, limite }); return salvos.at(-1) } }, limites)
    for (const valor of [limite - 0.01, limite]) assert.equal(await service.processar({ ...evento, dominio, valor }), null)
    assert.equal(salvos.length, 0)
    const valor = limite + 0.01
    assert.deepEqual(await service.processar({ ...evento, dominio, valor }), { ...evento, dominio, valor, limite })
    assert.equal(salvos.length, 1)
  })
}

test('limites: defaults, substituicoes e configuracao invalida', () => {
  assert.deepEqual(limites, { ALAGAMENTO: 150, QUALIDADE_AR: 35, TRANSITO: 0.8 })
  assert.deepEqual(carregarLimites({ ALERTA_NIVEL_CORREGO_CM: '0', ALERTA_MP25: '40', ALERTA_OCUPACAO: '1' }),
    { ALAGAMENTO: 0, QUALIDADE_AR: 40, TRANSITO: 1 })
  for (const nome of ['ALERTA_NIVEL_CORREGO_CM', 'ALERTA_MP25', 'ALERTA_OCUPACAO']) {
    for (const valor of ['', ' ', 'abc', 'Infinity', 'NaN', '-1']) assert.throws(() => carregarLimites({ [nome]: valor }), /Configuracao invalida/)
  }
  assert.throws(() => carregarLimites({ ALERTA_OCUPACAO: '1.01' }), /Configuracao invalida/)
})

test('evento: valida versao, dominio, IDs, valor e timestamp', () => {
  const json = { versao: 1, ...evento }
  assert.deepEqual(lerEvento(JSON.stringify(json)), evento)
  for (const invalido of [null, {}, { ...json, versao: 2 }, { ...json, dominio: 'OUTRO' },
    { ...json, dominio: ['ALAGAMENTO'] }, { ...json, dominio: { tipo: 'ALAGAMENTO' } },
    { ...json, sensorId: 0 }, { ...json, leituraId: 1.5 }, { ...json, valor: '151' },
    { ...json, valor: null }, { ...json, timestamp: '2026-02-30T12:00:00Z' }, { ...json, timestamp: '2026-01-15T09:30:00' }]) {
    assert.throws(() => lerEvento(JSON.stringify(invalido)))
  }
  assert.throws(() => lerEvento('json invalido'))
})

test('pendencias: remove somente apos confirmacao; falhas preservam o trabalho', async () => {
  const tarefas = [{ ...evento, id: 7 }], removidos = [], enviados = []
  const repository = { buscarPendentes: async () => tarefas, removerPendente: async id => removidos.push(id) }
  const service = createAlertasService(repository, limites)
  await assert.rejects(service.publicarPendentes(async () => { throw new Error('broker indisponivel') }))
  assert.deepEqual(removidos, [])
  assert.equal(await service.publicarPendentes(async data => { enviados.push(data) }), 1)
  assert.deepEqual(enviados, [evento]); assert.deepEqual(removidos, [7])
  repository.removerPendente = async () => { throw new Error('banco indisponivel apos confirmacao') }
  await assert.rejects(service.publicarPendentes(async data => { enviados.push(data) }))
  assert.equal(enviados.length, 2)
})

test('controller: isola dominio, serializa as duas datas e preserva resposta 500', async () => {
  const dominios = [], alerta = { ...evento, id: 1, limite: 150, createdAt: new Date('2026-01-15T09:31:00Z') }
  const service = { listar: async dominio => { dominios.push(dominio); return [alerta] } }
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this }, json(body) { this.body = body } }
  await createAlertasController(service, 'ALAGAMENTO').listar({}, res)
  assert.deepEqual(dominios, ['ALAGAMENTO'])
  assert.equal(res.body[0].timestamp, evento.timestamp.toISOString())
  assert.equal(res.body[0].createdAt, alerta.createdAt.toISOString())
  assert.ok(alerta.timestamp instanceof Date)
  const anterior = console.error
  try {
    console.error = () => {}
    await createAlertasController({ listar: async () => { throw new Error('falha') } }, 'TRANSITO').listar({}, res)
    assert.equal(res.statusCode, 500)
    assert.deepEqual(res.body, { error: 'erro ao consultar os alertas' })
  } finally { console.error = anterior }
})
