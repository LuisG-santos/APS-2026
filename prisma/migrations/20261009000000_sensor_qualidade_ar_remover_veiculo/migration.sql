ALTER TABLE "QualidadeAr" ADD COLUMN "sensor" TEXT;

-- Leituras anteriores nao possuem identificacao individual do sensor.
UPDATE "QualidadeAr" SET "sensor" = 'legado:' || "estacao";

ALTER TABLE "QualidadeAr" ALTER COLUMN "sensor" SET NOT NULL;

ALTER TABLE "Transito" DROP COLUMN "veiculo";