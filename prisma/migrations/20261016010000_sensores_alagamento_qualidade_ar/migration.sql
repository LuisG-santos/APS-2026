BEGIN;

CREATE TYPE "TipoSensorAlagamento" AS ENUM ('NIVEL', 'CHUVA');

CREATE TABLE "SensorAlagamento" (
    "id" SERIAL NOT NULL,
    "nome" TEXT NOT NULL,
    "tipo" "TipoSensorAlagamento" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SensorAlagamento_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SensorAlagamento_nome_key" ON "SensorAlagamento"("nome");

ALTER TABLE "Alagamento" ADD COLUMN "sensorId" INTEGER,
    ALTER COLUMN "nivelCorregoCm" DROP NOT NULL,
    ALTER COLUMN "chuvaAcumuladaMm" DROP NOT NULL;

-- O nome antigo identifica a origem; o sufixo separa o tipo de medicao.
INSERT INTO "SensorAlagamento" ("nome", "tipo")
SELECT DISTINCT 'legado:' || leitura."sensor" || ':' || origem.tipo, origem.tipo::"TipoSensorAlagamento"
FROM "Alagamento" AS leitura
CROSS JOIN (VALUES ('NIVEL'), ('CHUVA')) AS origem(tipo);

INSERT INTO "Alagamento" ("sensor", "sensorId", "timestamp", "chuvaAcumuladaMm", "createdAt")
SELECT leitura."sensor", sensor."id", leitura."timestamp", leitura."chuvaAcumuladaMm", leitura."createdAt"
FROM "Alagamento" AS leitura
JOIN "SensorAlagamento" AS sensor ON sensor."nome" = 'legado:' || leitura."sensor" || ':CHUVA'
WHERE leitura."sensorId" IS NULL;

-- A primeira medida preserva o ID original; as demais recebem novos IDs.
UPDATE "Alagamento" AS leitura
SET "sensorId" = sensor."id", "chuvaAcumuladaMm" = NULL
FROM "SensorAlagamento" AS sensor
WHERE sensor."nome" = 'legado:' || leitura."sensor" || ':NIVEL' AND leitura."sensorId" IS NULL;

ALTER TABLE "Alagamento"
    DROP COLUMN "sensor",
    ALTER COLUMN "sensorId" SET NOT NULL,
    ADD CONSTRAINT "Alagamento_sensorId_fkey" FOREIGN KEY ("sensorId")
        REFERENCES "SensorAlagamento"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "Alagamento_uma_medida_check" CHECK (num_nonnulls("nivelCorregoCm", "chuvaAcumuladaMm") = 1);

CREATE INDEX "Alagamento_sensorId_timestamp_idx" ON "Alagamento"("sensorId", "timestamp");

CREATE TYPE "TipoSensorQualidadeAr" AS ENUM ('MP25', 'CO', 'NO3', 'TEMPERATURA');

CREATE TABLE "SensorQualidadeAr" (
    "id" SERIAL NOT NULL,
    "nome" TEXT NOT NULL,
    "tipo" "TipoSensorQualidadeAr" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SensorQualidadeAr_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SensorQualidadeAr_nome_key" ON "SensorQualidadeAr"("nome");

ALTER TABLE "QualidadeAr" ADD COLUMN "sensorId" INTEGER,
    ALTER COLUMN "mp25" DROP NOT NULL,
    ALTER COLUMN "co" DROP NOT NULL,
    ALTER COLUMN "no3" DROP NOT NULL,
    ALTER COLUMN "temperatura" DROP NOT NULL;

-- O nome antigo identifica a origem; o sufixo separa o tipo de medicao.
INSERT INTO "SensorQualidadeAr" ("nome", "tipo")
SELECT DISTINCT 'legado:' || leitura."sensor" || ':' || origem.tipo, origem.tipo::"TipoSensorQualidadeAr"
FROM "QualidadeAr" AS leitura
CROSS JOIN (VALUES ('MP25'), ('CO'), ('NO3'), ('TEMPERATURA')) AS origem(tipo);

INSERT INTO "QualidadeAr" ("sensor", "sensorId", "timestamp", "co", "createdAt", "estacao")
SELECT leitura."sensor", sensor."id", leitura."timestamp", leitura."co", leitura."createdAt", leitura."estacao"
FROM "QualidadeAr" AS leitura
JOIN "SensorQualidadeAr" AS sensor ON sensor."nome" = 'legado:' || leitura."sensor" || ':CO'
WHERE leitura."sensorId" IS NULL;

INSERT INTO "QualidadeAr" ("sensor", "sensorId", "timestamp", "no3", "createdAt", "estacao")
SELECT leitura."sensor", sensor."id", leitura."timestamp", leitura."no3", leitura."createdAt", leitura."estacao"
FROM "QualidadeAr" AS leitura
JOIN "SensorQualidadeAr" AS sensor ON sensor."nome" = 'legado:' || leitura."sensor" || ':NO3'
WHERE leitura."sensorId" IS NULL;

INSERT INTO "QualidadeAr" ("sensor", "sensorId", "timestamp", "temperatura", "createdAt", "estacao")
SELECT leitura."sensor", sensor."id", leitura."timestamp", leitura."temperatura", leitura."createdAt", leitura."estacao"
FROM "QualidadeAr" AS leitura
JOIN "SensorQualidadeAr" AS sensor ON sensor."nome" = 'legado:' || leitura."sensor" || ':TEMPERATURA'
WHERE leitura."sensorId" IS NULL;

-- A primeira medida preserva o ID original; as demais recebem novos IDs.
UPDATE "QualidadeAr" AS leitura
SET "sensorId" = sensor."id", "co" = NULL, "no3" = NULL, "temperatura" = NULL
FROM "SensorQualidadeAr" AS sensor
WHERE sensor."nome" = 'legado:' || leitura."sensor" || ':MP25' AND leitura."sensorId" IS NULL;

ALTER TABLE "QualidadeAr"
    DROP COLUMN "sensor",
    ALTER COLUMN "sensorId" SET NOT NULL,
    ADD CONSTRAINT "QualidadeAr_sensorId_fkey" FOREIGN KEY ("sensorId")
        REFERENCES "SensorQualidadeAr"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "QualidadeAr_uma_medida_check" CHECK (num_nonnulls("mp25", "co", "no3", "temperatura") = 1);

CREATE INDEX "QualidadeAr_sensorId_timestamp_idx" ON "QualidadeAr"("sensorId", "timestamp");

COMMIT;
