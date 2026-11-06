BEGIN;

-- Renomeia os tipos existentes, mantendo IDs, nomes, leituras e relacionamentos.
ALTER TYPE "TipoSensorAlagamento" RENAME VALUE 'NIVEL' TO 'NIVEL_CORREGO';
ALTER TYPE "TipoSensorAlagamento" RENAME VALUE 'CHUVA' TO 'PLUVIOMETRO';
ALTER TYPE "TipoSensorAlagamento" ADD VALUE 'NIVEL_VIA';

ALTER TABLE "Alagamento"
    ADD COLUMN "nivelAguaViaCm" DOUBLE PRECISION,
    DROP CONSTRAINT "Alagamento_uma_medida_check",
    ADD CONSTRAINT "Alagamento_uma_medida_check"
        CHECK (num_nonnulls("nivelCorregoCm", "chuvaAcumuladaMm", "nivelAguaViaCm") = 1);

COMMIT;
