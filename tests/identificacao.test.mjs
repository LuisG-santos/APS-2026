import assert from 'node:assert/strict'
import { once } from 'node:events'
import { hostname } from 'node:os'
import { test } from 'node:test'
import { createApp as alagamento } from '../dist/api-alagamento-inundacao/app.js'
import { createApp as qualidadeAr } from '../dist/api-qualidade-do-ar/app.js'
import { createApp as transito } from '../dist/api-transito-e-transporte/app.js'

for (const [nome, criar] of [['alagamento', alagamento], ['qualidade-ar', qualidadeAr], ['transito', transito]]) {
  test(`${nome}: identifica a instancia inclusive em respostas de erro, sem acessar banco`, async t => {
    const server = criar({}).listen(0, '127.0.0.1')
    await once(server, 'listening')
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
    const base = `http://127.0.0.1:${server.address().port}`
    for (const [rota, status] of [['/health/live', 200], ['/rota-inexistente', 404]]) {
      const response = await fetch(base + rota)
      assert.equal(response.status, status)
      assert.equal(response.headers.get('x-pod'), process.env.POD_NAME ?? hostname())
      assert.equal(response.headers.get('x-versao'), process.env.APP_VERSION ?? 'nao-informada')
      await response.text()
    }
    const invalido = await fetch(base + '/send/sensor', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
    })
    assert.equal(invalido.status, 400)
    assert.ok(invalido.headers.get('x-pod'))
    await invalido.text()
  })
}
