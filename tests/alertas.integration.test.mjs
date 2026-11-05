import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { setTimeout as aguardar } from 'node:timers/promises'
import { test } from 'node:test'
import { PrismaClient } from '@prisma/client'
import { connect } from 'amqplib'
import { createApp as alagamento } from '../dist/api-alagamento-inundacao/app.js'
import { createApp as qualidadeAr } from '../dist/api-qualidade-do-ar/app.js'
import { createApp as transito } from '../dist/api-transito-e-transporte/app.js'
import { createLeiturasRepository as alagamentoRepository } from '../dist/api-alagamento-inundacao/repositories/leituras.repository.js'
import { createLeiturasRepository as qualidadeRepository } from '../dist/api-qualidade-do-ar/repositories/leituras.repository.js'
import { createLeiturasRepository as transitoRepository } from '../dist/api-transito-e-transporte/repositories/leituras.repository.js'
import { createAlertasRepository } from '../dist/shared/alertas/alertas.repository.js'
import { carregarLimites, createAlertasService } from '../dist/shared/alertas/alertas.service.js'
import { iniciarWorker } from '../dist/shared/alertas/worker.js'
import { NOME_FILA, FILA_INVALIDOS } from '../dist/shared/alertas/fila.js'

async function esperar(check) {
  for (let i = 0; i < 150; i++) { const result = await check(); if (result) return result; await aguardar(100) }
  throw new Error('Timeout no processamento dos alertas')
}

test('PostgreSQL + RabbitMQ: atomicidade, fila, worker, reentrega, GET e isolamento', {
  skip: !(process.env.TEST_DATABASE_URL && process.env.TEST_RABBITMQ_URL)
}, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL } } })
  const conexao = await connect(process.env.TEST_RABBITMQ_URL)
  conexao.on('error', () => {})
  const canal = await conexao.createConfirmChannel()
  canal.on('error', () => {})
  await canal.assertQueue(FILA_INVALIDOS, { durable: true })
  await canal.assertQueue(NOME_FILA, { durable: true, deadLetterExchange: '', deadLetterRoutingKey: FILA_INVALIDOS })
  // O broker TEST_RABBITMQ_URL deve ser exclusivo de testes.
  await canal.purgeQueue(NOME_FILA); await canal.purgeQueue(FILA_INVALIDOS)
  const apis = [
    { app: alagamento, repository: alagamentoRepository, dominio: 'ALAGAMENTO', rota: 'alagamento', model: 'alagamento', sensor: 'sensorAlagamento', tipo: 'NIVEL_CORREGO', campo: 'nivelCorregoCm', limite: 150, extras: [['PLUVIOMETRO','chuvaAcumuladaMm',12],['NIVEL_VIA','nivelAguaViaCm',5]] },
    { app: qualidadeAr, repository: qualidadeRepository, dominio: 'QUALIDADE_AR', rota: 'qualidade-ar', model: 'qualidadeAr', sensor: 'sensorQualidadeAr', tipo: 'MP25', campo: 'mp25', limite: 35, extra: { estacao: 'teste-fila' }, extras: [['CO','co',1],['NO2','no2',12],['TEMPERATURA','temperatura',28]] },
    { app: transito, repository: transitoRepository, dominio: 'TRANSITO', rota: 'transito', model: 'transito', sensor: 'sensorTransito', tipo: 'OCUPACAO', campo: 'ocupacao', limite: 0.8, extras: [['RADAR','velocidade',55],['GPS','posicao','-23.55,-46.63']] }
  ]
  let worker
  const prefix = `teste-alertas-${randomUUID()}`, timestamp = '2026-01-15T09:30:00.123Z'
  const repository = createAlertasRepository(prisma)
  try {
    for (const api of apis) {
      api.ids = []; api.sensorIds = []
      api.server = api.app(prisma).listen(0, '127.0.0.1'); await once(api.server, 'listening')
      api.url = `http://127.0.0.1:${api.server.address().port}`
      const sensor = await prisma[api.sensor].create({ data: { nome: `${prefix}-${api.rota}`, tipo: api.tipo, ...api.extra } })
      api.sensorIds.push(sensor.id)
      // Se a gravacao do trabalho falhar, a leitura precisa ser revertida no PostgreSQL real.
      const comFalha = { $transaction: operation => prisma.$transaction(tx => operation({
        [api.model]: tx[api.model], tarefaAlerta: { create: async () => { throw new Error('falha simulada no trabalho') } }
      })) }
      const antes = await prisma[api.model].count({ where: { sensorId: sensor.id } })
      await assert.rejects(api.repository(comFalha).criar({ sensorId: sensor.id, timestamp: new Date(timestamp), [api.campo]: api.limite + 0.01 }))
      assert.equal(await prisma[api.model].count({ where: { sensorId: sensor.id } }), antes)
      for (const valor of [api.limite - 0.01, api.limite, api.limite + 0.01]) {
        const response = await fetch(`${api.url}/send/${api.rota}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sensorId: sensor.id, timestamp, [api.campo]: valor }) })
        assert.equal(response.status, 201)
        const leitura = await response.json(); api.ids.push(leitura.id)
        const tarefa = await prisma.tarefaAlerta.findUnique({ where: { dominio_leituraId: { dominio: api.dominio, leituraId: leitura.id } } })
        assert.equal(tarefa.valor, valor); assert.equal(tarefa.timestamp.toISOString(), timestamp)
        api.evento = { dominio: api.dominio, leituraId: leitura.id, sensorId: sensor.id, valor, timestamp: new Date(timestamp) }
      }
      for (const [tipo, campo, valor] of api.extras) {
        const extra = await prisma[api.sensor].create({ data: { nome: `${prefix}-${tipo}`, tipo, ...api.extra } }); api.sensorIds.push(extra.id)
        const leitura = await api.repository(prisma).criar({ sensorId: extra.id, timestamp: new Date(timestamp), [campo]: valor }); api.ids.push(leitura.id)
        assert.equal(await prisma.tarefaAlerta.count({ where: { dominio: api.dominio, leituraId: leitura.id } }), 0)
      }
    }
    // Sem confirmacao do RabbitMQ, nenhuma das tarefas das APIs pode ser removida.
    const service = createAlertasService(repository)
    const pendentes = await prisma.tarefaAlerta.count()
    await assert.rejects(service.publicarPendentes(async () => { throw new Error('sem confirmacao') }))
    assert.equal(await prisma.tarefaAlerta.count(), pendentes)
    let falhou = false
    worker = iniciarWorker({ ...repository, salvar: async (evento, limite) => {
      if (!falhou && evento.dominio === apis[0].dominio && evento.leituraId === apis[0].evento.leituraId) {
        falhou = true; throw new Error('banco indisponivel uma vez')
      }
      return repository.salvar(evento, limite)
    } }, process.env.TEST_RABBITMQ_URL, carregarLimites({}))
    for (const api of apis) {
      await esperar(async () => await prisma.alerta.count({ where: { dominio: api.dominio, leituraId: api.evento.leituraId } }) === 1)
      const response = await fetch(`${api.url}/get/alertas`)
      assert.equal(response.status, 200)
      const alertas = await response.json()
      assert.ok(alertas.every(a => a.dominio === api.dominio))
      const proprios = alertas.filter(a => api.ids.includes(a.leituraId))
      assert.equal(proprios.length, 1)
      assert.equal(proprios[0].valor, api.limite + 0.01)
      assert.equal(proprios[0].limite, api.limite)
      assert.equal(proprios[0].timestamp, timestamp)
      assert.ok(Number.isFinite(Date.parse(proprios[0].createdAt)))
      // Simula a janela de falha apos publicar e antes de remover o trabalho.
      canal.sendToQueue(NOME_FILA, Buffer.from(JSON.stringify({ versao: 1, ...api.evento })), { persistent: true })
      canal.sendToQueue(NOME_FILA, Buffer.from(JSON.stringify({ versao: 1, ...api.evento })), { persistent: true })
    }
    canal.sendToQueue(NOME_FILA, Buffer.from('json invalido'), { persistent: true })
    await canal.waitForConfirms()
    await esperar(async () => (await canal.checkQueue(FILA_INVALIDOS)).messageCount === 1)
    for (const api of apis) assert.equal(await prisma.alerta.count({ where: { dominio: api.dominio, leituraId: { in: api.ids } } }), 1)
    assert.equal(falhou, true)
    await esperar(async () => await prisma.tarefaAlerta.count() === 0)
    await worker.verificarConexao()
  } finally {
    await worker?.fechar()
    for (const api of apis) {
      if (api.server) await new Promise(resolve => api.server.close(resolve))
      if (!api.ids) continue
      const where = { dominio: api.dominio, leituraId: { in: api.ids } }
      await prisma.tarefaAlerta.deleteMany({ where }); await prisma.alerta.deleteMany({ where })
      await prisma[api.model].deleteMany({ where: { id: { in: api.ids } } })
      await prisma[api.sensor].deleteMany({ where: { id: { in: api.sensorIds } } })
    }
    await conexao.close(); await prisma.$disconnect()
  }
})
