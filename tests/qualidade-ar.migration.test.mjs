import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { PrismaClient } from '@prisma/client'

const nomeMigration = '20261104010000_restaurar_sensores_qualidade_ar'
const root = new URL('../prisma/migrations/', import.meta.url)

async function aplicar(tx, nome) {
  const sql = (await readFile(new URL(`${nome}/migration.sql`, root), 'utf8')).replace(/--[^\n]*/g, '')
  // O bloco PL/pgSQL contem ponto e virgula internos e deve ser executado inteiro.
  for (const trecho of sql.split(/(DO \$\$[\s\S]*?\$\$;)/).map(item => item.trim()).filter(Boolean)) {
    if (trecho.startsWith('DO $$')) {
      await tx.$executeRawUnsafe(trecho)
    } else {
      for (const comando of trecho.split(';').map(item => item.trim()).filter(Boolean)) {
        if (!/^(BEGIN|COMMIT)$/i.test(comando)) await tx.$executeRawUnsafe(comando)
      }
    }
  }
}

for (const comDados of [false, true]) {
  test(`migration de qualidade do ar: ${comDados ? 'preserva dados e separa estacoes' : 'banco vazio'}`, {
    skip: !process.env.TEST_DATABASE_URL && 'Defina TEST_DATABASE_URL para verificar a migration em PostgreSQL.'
  }, async () => {
    const prisma = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL } } })
    const schema = `teste_ar_${randomUUID().replaceAll('-', '')}`
    const rollback = new Error('rollback do teste')
    try {
      await assert.rejects(prisma.$transaction(async tx => {
        await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
        await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`)
        for (const nome of (await readdir(root)).filter(nome => /^\d/.test(nome) && nome < nomeMigration).sort()) await aplicar(tx, nome)
        if (comDados) {
          await tx.$executeRawUnsafe(`INSERT INTO "SensorQualidadeAr" ("nome", "tipo", "createdAt") VALUES ('multi', 'NO3', '2000-01-01'), ('unico', 'MP25', '2000-01-01'), ('sem-leitura', 'CO', '2000-01-01'), ('multi:estacao:z', 'TEMPERATURA', '2000-01-01')`)
          await tx.$executeRawUnsafe(`INSERT INTO "QualidadeAr" ("sensorId", "estacao", "timestamp", "no3", "createdAt") SELECT "id", 'a', '2001-01-01', 0, '2002-01-01' FROM "SensorQualidadeAr" WHERE "nome" = 'multi'`)
          await tx.$executeRawUnsafe(`INSERT INTO "QualidadeAr" ("sensorId", "estacao", "timestamp", "no3", "createdAt") SELECT "id", 'z', '2001-02-01', 12.4, '2002-01-01' FROM "SensorQualidadeAr" WHERE "nome" = 'multi'`)
          await tx.$executeRawUnsafe(`INSERT INTO "QualidadeAr" ("sensorId", "estacao", "timestamp", "mp25", "createdAt") SELECT "id", 'centro', '2001-01-01', 35.2, '2002-01-01' FROM "SensorQualidadeAr" WHERE "nome" = 'unico'`)
          await tx.$executeRawUnsafe(`INSERT INTO "SensorAlagamento" ("nome", "tipo") VALUES ('nivel-original', 'NIVEL_CORREGO')`)
          await tx.$executeRawUnsafe(`INSERT INTO "Alagamento" ("sensorId", "timestamp", "nivelCorregoCm") SELECT "id", '2001-01-01', 120 FROM "SensorAlagamento"`)
          await tx.$executeRawUnsafe(`INSERT INTO "SensorTransito" ("nome", "tipo") VALUES ('radar-original', 'RADAR')`)
          await tx.$executeRawUnsafe(`INSERT INTO "Transito" ("sensorId", "timestamp", "velocidade") SELECT "id", '2001-01-01', 42 FROM "SensorTransito"`)
        }
        const sensoresAntes = await tx.$queryRawUnsafe('SELECT * FROM "SensorQualidadeAr" ORDER BY "id"')
        const leiturasAntes = await tx.$queryRawUnsafe('SELECT * FROM "QualidadeAr" ORDER BY "id"')
        const outrasTabelas = ['Alagamento', 'SensorAlagamento', 'Transito', 'SensorTransito']
        const outrosAntes = await Promise.all(outrasTabelas.map(tabela => tx.$queryRawUnsafe(`SELECT * FROM "${tabela}" ORDER BY "id"`)))
        await aplicar(tx, nomeMigration)
        const sensoresDepois = await tx.$queryRawUnsafe('SELECT * FROM "SensorQualidadeAr" ORDER BY "id"')
        const leiturasDepois = await tx.$queryRawUnsafe('SELECT * FROM "QualidadeAr" ORDER BY "id"')
        assert.equal(leiturasDepois.length, leiturasAntes.length)
        for (const antes of leiturasAntes) {
          const depois = leiturasDepois.find(leitura => leitura.id === antes.id)
          const sensor = sensoresDepois.find(sensor => sensor.id === depois.sensorId)
          const { estacao, no3, sensorId, ...campos } = antes
          assert.equal(sensor.estacao, estacao)
          assert.deepEqual(depois, { ...campos, sensorId: sensor.id, no2: no3 })
          assert.equal(sensor.tipo, sensoresAntes.find(sensor => sensor.id === sensorId).tipo === 'NO3' ? 'NO2' : 'MP25')
        }
        if (comDados) {
          assert.equal(sensoresDepois.length, sensoresAntes.length + 1)
          for (const antes of sensoresAntes) {
            const depois = sensoresDepois.find(sensor => sensor.id === antes.id)
            assert.equal(depois.nome, antes.nome)
            assert.deepEqual(depois.createdAt, antes.createdAt)
          }
          assert.equal(sensoresDepois.find(sensor => sensor.nome === 'multi').estacao, 'a')
          assert.equal(sensoresDepois.find(sensor => sensor.nome === 'multi:estacao:z:').estacao, 'z')
          assert.equal(sensoresDepois.find(sensor => sensor.nome === 'sem-leitura').estacao, 'legado:sem-estacao')
        } else {
          assert.deepEqual(sensoresDepois, [])
        }
        for (const [index, tabela] of outrasTabelas.entries()) {
          assert.deepEqual(await tx.$queryRawUnsafe(`SELECT * FROM "${tabela}" ORDER BY "id"`), outrosAntes[index])
        }
        throw rollback
      }, { timeout: 30000 }), error => error === rollback)
    } finally {
      await prisma.$disconnect()
    }
  })
}
