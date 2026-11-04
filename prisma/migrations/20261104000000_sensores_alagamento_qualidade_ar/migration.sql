BEGIN;

-- Reinicia somente as leituras das duas APIs, conforme a mudanca de contrato.

DELETE FROM "Alagamento";

DELETE FROM "QualidadeAr";

CREATE TYPE "TipoSensorAlagamento" AS ENUM ('NIVEL_CORREGO', 'PLUVIOMETRO', 'NIVEL_VIA');

CREATE TABLE "SensorAlagamento" (
    "id" SERIAL PRIMARY KEY, "nome" TEXT NOT NULL,
    "tipo" "TipoSensorAlagamento" NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "SensorAlagamento_nome_key" ON "SensorAlagamento"("nome");

ALTER TABLE "Alagamento" DROP COLUMN "sensor", ADD COLUMN "nivelAguaViaCm" DOUBLE PRECISION;

ALTER TABLE "Alagamento"
    ADD COLUMN "sensorId" INTEGER NOT NULL,
    ALTER COLUMN "nivelCorregoCm" DROP NOT NULL,
    ALTER COLUMN "chuvaAcumuladaMm" DROP NOT NULL,
    ALTER COLUMN "nivelAguaViaCm" DROP NOT NULL,
    ADD CONSTRAINT "Alagamento_sensorId_fkey" FOREIGN KEY ("sensorId") REFERENCES "SensorAlagamento"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "Alagamento_uma_medida_check" CHECK (num_nonnulls("nivelCorregoCm", "chuvaAcumuladaMm", "nivelAguaViaCm") = 1);

CREATE INDEX "Alagamento_sensorId_timestamp_idx" ON "Alagamento"("sensorId", "timestamp");

CREATE TYPE "TipoSensorQualidadeAr" AS ENUM ('MP25', 'CO', 'NO2', 'TEMPERATURA');

CREATE TABLE "SensorQualidadeAr" (
    "id" SERIAL PRIMARY KEY, "nome" TEXT NOT NULL,
    "tipo" "TipoSensorQualidadeAr" NOT NULL, "estacao" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "SensorQualidadeAr_nome_key" ON "SensorQualidadeAr"("nome");

ALTER TABLE "QualidadeAr" DROP COLUMN "sensor", DROP COLUMN "estacao";

ALTER TABLE "QualidadeAr" RENAME COLUMN "no3" TO "no2";

ALTER TABLE "QualidadeAr"
    ADD COLUMN "sensorId" INTEGER NOT NULL,
    ALTER COLUMN "mp25" DROP NOT NULL,
    ALTER COLUMN "co" DROP NOT NULL,
    ALTER COLUMN "no2" DROP NOT NULL,
    ALTER COLUMN "temperatura" DROP NOT NULL,
    ADD CONSTRAINT "QualidadeAr_sensorId_fkey" FOREIGN KEY ("sensorId") REFERENCES "SensorQualidadeAr"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "QualidadeAr_uma_medida_check" CHECK (num_nonnulls("mp25", "co", "no2", "temperatura") = 1);

CREATE INDEX "QualidadeAr_sensorId_timestamp_idx" ON "QualidadeAr"("sensorId", "timestamp");

COMMIT;
