import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { PrismaClient } from '@prisma/client'

const migration = '20261105000000_fila_alertas', root = new URL('../prisma/migrations/', import.meta.url)
async function aplicar(tx, nome) {
  const sql = (await readFile(new URL(`${nome}/migration.sql`, root), 'utf8')).replace(/--[^\n]*/g, '')
  for (const trecho of sql.split(/(DO \$\$[\s\S]*?\$\$;)/).map(s => s.trim()).filter(Boolean)) {
    if (trecho.startsWith('DO $$')) await tx.$executeRawUnsafe(trecho)
    else for (const comando of trecho.split(';').map(s => s.trim()).filter(Boolean)) {
      if (!/^(BEGIN|COMMIT)$/i.test(comando)) await tx.$executeRawUnsafe(comando)
    }
  }
}
for (const comDados of [false, true]) {
  test(`migration de alertas: ${comDados ? 'preserva os tres dominios sem tarefas retroativas' : 'banco vazio'}`, {
    skip: !process.env.TEST_DATABASE_URL
  }, async () => {
    const prisma = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL } } })
    const schema = `teste_fila_${randomUUID().replaceAll('-', '')}`, rollback = new Error('rollback')
    try {
      await assert.rejects(prisma.$transaction(async tx => {
        await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
        await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`)
        for (const nome of (await readdir(root)).filter(s => /^\d/.test(s) && s < migration).sort()) await aplicar(tx, nome)
        if (comDados) {
          await tx.$executeRawUnsafe(`INSERT INTO "SensorAlagamento" ("nome","tipo") VALUES ('nivel','NIVEL_CORREGO')`)
          await tx.$executeRawUnsafe(`INSERT INTO "Alagamento" ("sensorId","timestamp","nivelCorregoCm") VALUES (1,'2026-01-01',180)`)
          await tx.$executeRawUnsafe(`INSERT INTO "SensorQualidadeAr" ("nome","tipo","estacao") VALUES ('ar','MP25','centro')`)
          await tx.$executeRawUnsafe(`INSERT INTO "QualidadeAr" ("sensorId","timestamp","mp25") VALUES (1,'2026-01-01',50)`)
          await tx.$executeRawUnsafe(`INSERT INTO "SensorTransito" ("nome","tipo") VALUES ('ocupacao','OCUPACAO')`)
          await tx.$executeRawUnsafe(`INSERT INTO "Transito" ("sensorId","timestamp","ocupacao") VALUES (1,'2026-01-01',0.95)`)
        }
        const tabelas = ['SensorAlagamento','Alagamento','SensorQualidadeAr','QualidadeAr','SensorTransito','Transito']
        const antes = await Promise.all(tabelas.map(t => tx.$queryRawUnsafe(`SELECT * FROM "${t}" ORDER BY "id"`)))
        await aplicar(tx, migration)
        for (const [i,t] of tabelas.entries()) assert.deepEqual(await tx.$queryRawUnsafe(`SELECT * FROM "${t}" ORDER BY "id"`), antes[i])
        assert.deepEqual(await tx.$queryRawUnsafe('SELECT * FROM "TarefaAlerta"'), [])
        assert.deepEqual(await tx.$queryRawUnsafe('SELECT * FROM "Alerta"'), [])
        throw rollback
      }, { timeout: 30000 }), e => e === rollback)
    } finally { await prisma.$disconnect() }
  })
}
