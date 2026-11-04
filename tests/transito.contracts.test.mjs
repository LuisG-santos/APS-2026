import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isSensorBody, isTransitoBody } from '../dist/api-transito-e-transporte/contracts.js'

const medidas = [['RADAR', 'velocidade', 42.5], ['GPS', 'posicao', '-23.5505,-46.6333'], ['OCUPACAO', 'ocupacao', 0.75]]
const base = { sensorId: 1, timestamp: '2026-11-04T12:00:00Z' }

for (const [tipo, campo, valor] of medidas) {
  test(`transito: ${tipo} aceita o formato da sua unica medida`, () => {
    assert.equal(isSensorBody({ nome: 'sensor-01', tipo }), true)
    const body = { ...base, [campo]: valor }
    assert.equal(isTransitoBody(body), true)
    for (const [, outroCampo, outroValor] of medidas.filter(([outroTipo]) => outroTipo !== tipo)) {
      assert.equal(isTransitoBody({ ...body, [outroCampo]: outroValor }), false)
      assert.equal(isTransitoBody({ ...body, [outroCampo]: null }), false)
    }
    const invalidos = campo === 'posicao' ? [123, null, true, {}, '', '  '] : ['42.5', null, NaN, Infinity, true]
    for (const valor of invalidos) assert.equal(isTransitoBody({ ...base, [campo]: valor }), false)
  })
}

test('transito: rejeita tipo desconhecido, ID invalido e leitura sem medida', () => {
  assert.equal(isSensorBody({ nome: 'sensor-01', tipo: 'CAMERA' }), false)
  assert.equal(isTransitoBody(base), false)
  for (const sensorId of [undefined, '1', 0, -1, 1.5]) {
    assert.equal(isTransitoBody({ ...base, sensorId, velocidade: 42.5 }), false)
  }
})
