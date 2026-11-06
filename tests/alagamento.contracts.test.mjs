import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isAlagamentoBody, isSensorAlagamentoBody } from '../dist/api-alagamento-inundacao/contracts.js'

const medidas = [
  ['NIVEL_CORREGO', 'nivelCorregoCm', 120.5],
  ['PLUVIOMETRO', 'chuvaAcumuladaMm', 35.2],
  ['NIVEL_VIA', 'nivelAguaViaCm', 8]
]
const base = { sensorId: 1, timestamp: '2026-11-04T12:00:00Z' }

for (const [tipo, campo, valor] of medidas) {
  test(`alagamento: ${tipo} aceita somente sua medida`, () => {
    assert.equal(isSensorAlagamentoBody({ nome: 'sensor-01', tipo }), true)
    const body = { ...base, [campo]: valor }
    assert.equal(isAlagamentoBody(body), true)
    for (const [, outroCampo, outroValor] of medidas.filter(([item]) => item !== tipo)) {
      assert.equal(isAlagamentoBody({ ...body, [outroCampo]: outroValor }), false)
      assert.equal(isAlagamentoBody({ ...body, [outroCampo]: null }), false)
    }
    for (const invalido of ['8', null, NaN, Infinity, true]) {
      assert.equal(isAlagamentoBody({ ...base, [campo]: invalido }), false)
    }
  })
}

test('alagamento: rejeita tipos antigos, desconhecidos e leitura sem medida', () => {
  for (const tipo of ['NIVEL', 'CHUVA', 'RADAR', undefined]) {
    assert.equal(isSensorAlagamentoBody({ nome: 'sensor-01', tipo }), false)
  }
  assert.equal(isAlagamentoBody(base), false)
})
