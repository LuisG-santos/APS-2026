import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { PrismaClient } from '@prisma/client'

const nomeMigration = '20261104000000_restaurar_sensores_alagamento'
const root = new URL('../prisma/migrations/', import.meta.url)

async function aplicar(tx, nome) {
  const sql = await readFile(new URL(`${nome}/migration.sql`, root), 'utf8')
  for (const comando of sql.replace(/--[^\n]*/g, '').split(';').map(item => item.trim()).filter(Boolean)) {
    if (!/^(BEGIN|COMMIT)$/i.test(comando)) await tx.$executeRawUnsafe(comando)
  }
}

test('migration de alagamento preserva sensores e leituras ao renomear os tipos', {
  skip: !process.env.TEST_DATABASE_URL && 'Defina TEST_DATABASE_URL para verificar a migration em PostgreSQL.'
}, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL } } })
  const schema = `teste_alagamento_${randomUUID().replaceAll('-', '')}`
  const rollback = new Error('rollback do teste')
  try {
    await assert.rejects(prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`)
      for (const nome of (await readdir(root)).filter(nome => /^\d/.test(nome) && nome < nomeMigration).sort()) {
        await aplicar(tx, nome)
      }
      await tx.$executeRawUnsafe(`INSERT INTO "SensorAlagamento" ("nome", "tipo") VALUES ('nivel-original', 'NIVEL'), ('chuva-original', 'CHUVA')`)
      await tx.$executeRawUnsafe(`INSERT INTO "Alagamento" ("sensorId", "timestamp", "nivelCorregoCm") SELECT "id", '2026-01-15', 120.5 FROM "SensorAlagamento" WHERE "nome" = 'nivel-original'`)
      await tx.$executeRawUnsafe(`INSERT INTO "Alagamento" ("sensorId", "timestamp", "chuvaAcumuladaMm") SELECT "id", '2026-01-15', 35.2 FROM "SensorAlagamento" WHERE "nome" = 'chuva-original'`)
      const sensoresAntes = await tx.$queryRawUnsafe('SELECT * FROM "SensorAlagamento" ORDER BY "id"')
      const leiturasAntes = await tx.$queryRawUnsafe('SELECT * FROM "Alagamento" ORDER BY "id"')
      await aplicar(tx, nomeMigration)
      const sensoresDepois = await tx.$queryRawUnsafe('SELECT * FROM "SensorAlagamento" ORDER BY "id"')
      assert.deepEqual(sensoresDepois, sensoresAntes.map(sensor => ({ ...sensor, tipo: sensor.tipo === 'NIVEL' ? 'NIVEL_CORREGO' : 'PLUVIOMETRO' })))
      assert.deepEqual(await tx.$queryRawUnsafe('SELECT "id", "sensorId", "timestamp", "nivelCorregoCm", "chuvaAcumuladaMm", "nivelAguaViaCm", "createdAt" FROM "Alagamento" ORDER BY "id"'), leiturasAntes.map(leitura => ({ ...leitura, nivelAguaViaCm: null })))
      throw rollback
    }, { timeout: 30000 }), error => error === rollback)
  } finally {
    await prisma.$disconnect()
  }
})
