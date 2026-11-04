import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isQualidadeArBody, isSensorQualidadeArBody } from '../dist/api-qualidade-do-ar/contracts.js'

const medidas = [['MP25', 'mp25', 35.2], ['CO', 'co', 0.8], ['NO2', 'no2', 12.4], ['TEMPERATURA', 'temperatura', 27.5]]
const base = { sensorId: 1, timestamp: '2026-11-04T12:00:00Z' }

for (const [tipo, campo, valor] of medidas) {
  test(`qualidade-ar: ${tipo} aceita somente a medida correspondente`, () => {
    assert.equal(isSensorQualidadeArBody({ nome: 'sensor-01', tipo, estacao: 'centro' }), true)
    const body = { ...base, [campo]: valor }
    assert.equal(isQualidadeArBody(body), true)
    for (const [, outroCampo, outroValor] of medidas.filter(([item]) => item !== tipo)) {
      assert.equal(isQualidadeArBody({ ...body, [outroCampo]: outroValor }), false)
      assert.equal(isQualidadeArBody({ ...body, [outroCampo]: null }), false)
    }
    for (const invalido of ['12', null, NaN, Infinity, true]) {
      assert.equal(isQualidadeArBody({ ...base, [campo]: invalido }), false)
    }
  })
}

test('qualidade-ar: estacao e obrigatoria e textual no cadastro, sem tipo NO3', () => {
  for (const estacao of [undefined, null, '', '  ', 123, []]) {
    assert.equal(isSensorQualidadeArBody({ nome: 'sensor-01', tipo: 'MP25', estacao }), false)
  }
  assert.equal(isSensorQualidadeArBody({ nome: 'sensor-01', tipo: 'NO3', estacao: 'centro' }), false)
})

test('qualidade-ar: rejeita contrato antigo e leitura sem medida', () => {
  assert.equal(isQualidadeArBody(base), false)
  assert.equal(isQualidadeArBody({ ...base, no3: 12.4 }), false)
  assert.equal(isQualidadeArBody({ ...base, no2: 12.4, no3: 10 }), false)
  assert.equal(isQualidadeArBody({ ...base, mp25: 35.2, estacao: 'centro' }), false)
})
