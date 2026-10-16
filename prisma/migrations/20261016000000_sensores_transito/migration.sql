BEGIN;

CREATE TYPE "TipoSensorTransito" AS ENUM ('RADAR', 'GPS', 'OCUPACAO');

CREATE TABLE "SensorTransito" (
    "id" SERIAL NOT NULL,
    "nome" TEXT NOT NULL,
    "tipo" "TipoSensorTransito" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SensorTransito_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SensorTransito_nome_key" ON "SensorTransito"("nome");

ALTER TABLE "Transito"
    ADD COLUMN "sensorId" INTEGER,
    ALTER COLUMN "posicao" DROP NOT NULL,
    ALTER COLUMN "velocidade" DROP NOT NULL,
    ALTER COLUMN "ocupacao" DROP NOT NULL;

-- A origem fisica das leituras antigas nao era registrada.
INSERT INTO "SensorTransito" ("nome", "tipo")
SELECT origem.nome, origem.tipo::"TipoSensorTransito"
FROM (VALUES
    ('legado:radar', 'RADAR'),
    ('legado:gps', 'GPS'),
    ('legado:ocupacao', 'OCUPACAO')
) AS origem(nome, tipo)
WHERE EXISTS (SELECT 1 FROM "Transito");

INSERT INTO "Transito" ("sensorId", "timestamp", "posicao", "createdAt")
SELECT sensor."id", leitura."timestamp", leitura."posicao", leitura."createdAt"
FROM "Transito" AS leitura
JOIN "SensorTransito" AS sensor ON sensor."nome" = 'legado:gps'
WHERE leitura."sensorId" IS NULL;

INSERT INTO "Transito" ("sensorId", "timestamp", "ocupacao", "createdAt")
SELECT sensor."id", leitura."timestamp", leitura."ocupacao", leitura."createdAt"
FROM "Transito" AS leitura
JOIN "SensorTransito" AS sensor ON sensor."nome" = 'legado:ocupacao'
WHERE leitura."sensorId" IS NULL;

-- O ID original fica com a medida de velocidade; as demais recebem novos IDs.
UPDATE "Transito" AS leitura
SET "sensorId" = sensor."id", "posicao" = NULL, "ocupacao" = NULL
FROM "SensorTransito" AS sensor
WHERE sensor."nome" = 'legado:radar' AND leitura."sensorId" IS NULL;

ALTER TABLE "Transito"
    ALTER COLUMN "sensorId" SET NOT NULL,
    ADD CONSTRAINT "Transito_sensorId_fkey" FOREIGN KEY ("sensorId")
        REFERENCES "SensorTransito"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "Transito_uma_medida_check"
        CHECK (num_nonnulls("posicao", "velocidade", "ocupacao") = 1);

CREATE INDEX "Transito_sensorId_timestamp_idx" ON "Transito"("sensorId", "timestamp");

COMMIT;
