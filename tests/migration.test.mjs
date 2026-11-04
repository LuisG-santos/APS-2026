import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { PrismaClient } from '@prisma/client'

if (!process.env.TEST_DATABASE_URL) throw new Error('Defina TEST_DATABASE_URL para um banco de testes.')

// Cada cenario usa um schema temporario e rollback, sem modificar as tabelas existentes.
const migrationRoot = new URL('../prisma/migrations/', import.meta.url)
async function executeMigration(tx, name) {
  const sql = await readFile(new URL(`${name}/migration.sql`, migrationRoot), 'utf8')
  for (const statement of sql.replace(/--[^\n]*/g, '').split(';').map(value => value.trim()).filter(Boolean)) {
    if (!/^(BEGIN|COMMIT)$/i.test(statement)) await tx.$executeRawUnsafe(statement)
  }
}

for (const seeded of [false, true]) {
  test(`migration de sensores: banco ${seeded ? 'com leituras antigas' : 'vazio'}`, async () => {
    const prisma = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL } } })
    const schema = `migration_test_${randomUUID().replaceAll('-', '')}`
    const rollback = new Error('rollback do cenario de teste')
    try {
      await assert.rejects(prisma.$transaction(async tx => {
        await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
        await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`)
        const migrations = (await readdir(migrationRoot)).filter(name => /^\d/.test(name)).sort()
        for (const migration of migrations.filter(name => name < '20261104000000')) await executeMigration(tx, migration)
        if (seeded) {
          await tx.$executeRawUnsafe(`INSERT INTO "Alagamento" ("sensor", "timestamp", "nivelCorregoCm", "chuvaAcumuladaMm") VALUES ('antigo', '2026-01-15', 120, 35)`)
          await tx.$executeRawUnsafe(`INSERT INTO "QualidadeAr" ("sensor", "estacao", "timestamp", "mp25", "co", "no3", "temperatura") VALUES ('antigo', 'centro', '2026-01-15', 35, 0.8, 12, 27)`)
          await tx.$executeRawUnsafe(`INSERT INTO "SensorTransito" ("nome", "tipo") VALUES ('preservado', 'RADAR')`)
          await tx.$executeRawUnsafe(`INSERT INTO "Transito" ("sensorId", "timestamp", "velocidade") SELECT "id", '2026-01-15', 42 FROM "SensorTransito" WHERE "nome" = 'preservado'`)
        }
        const before = await tx.$queryRawUnsafe('SELECT * FROM "Transito" ORDER BY "id"')
        const sensorsBefore = await tx.$queryRawUnsafe('SELECT * FROM "SensorTransito" ORDER BY "id"')
        await executeMigration(tx, '20261104000000_sensores_alagamento_qualidade_ar')
        assert.deepEqual(await tx.$queryRawUnsafe('SELECT * FROM "Alagamento"'), [])
        assert.deepEqual(await tx.$queryRawUnsafe('SELECT * FROM "QualidadeAr"'), [])
        assert.deepEqual(await tx.$queryRawUnsafe('SELECT * FROM "Transito" ORDER BY "id"'), before)
        assert.deepEqual(await tx.$queryRawUnsafe('SELECT * FROM "SensorTransito" ORDER BY "id"'), sensorsBefore)
        await tx.$executeRawUnsafe(`INSERT INTO "SensorQualidadeAr" ("nome", "tipo", "estacao") VALUES ('novo', 'NO2', 'centro')`)
        await tx.$executeRawUnsafe(`INSERT INTO "QualidadeAr" ("sensorId", "timestamp", "no2") SELECT "id", '2026-01-15', 12.4 FROM "SensorQualidadeAr" WHERE "nome" = 'novo'`)
        await tx.$executeRawUnsafe(`INSERT INTO "SensorAlagamento" ("nome", "tipo") VALUES ('novo', 'NIVEL_VIA')`)
        await tx.$executeRawUnsafe(`INSERT INTO "Alagamento" ("sensorId", "timestamp", "nivelAguaViaCm") SELECT "id", '2026-01-15', 8 FROM "SensorAlagamento" WHERE "nome" = 'novo'`)
        throw rollback
      }, { timeout: 30000 }), error => error === rollback)
    } finally {
      await prisma.$disconnect()
    }
  })
}
