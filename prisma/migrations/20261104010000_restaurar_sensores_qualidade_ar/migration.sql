BEGIN;

ALTER TYPE "TipoSensorQualidadeAr" RENAME VALUE 'NO3' TO 'NO2';
ALTER TABLE "QualidadeAr" RENAME COLUMN "no3" TO "no2";
ALTER TABLE "SensorQualidadeAr" ADD COLUMN "estacao" TEXT;

-- Um cadastro passa a representar um equipamento em uma estacao fixa.
-- Se um sensor antigo possui leituras de varios locais, preserva o cadastro
-- original para a primeira estacao e cria cadastros para as demais.
DO $$
DECLARE
    origem RECORD;
    local_leitura RECORD;
    primeira_estacao BOOLEAN;
    novo_nome TEXT;
    novo_sensor_id INTEGER;
BEGIN
    FOR origem IN SELECT "id", "nome", "tipo", "createdAt" FROM "SensorQualidadeAr" ORDER BY "id" LOOP
        primeira_estacao := TRUE;
        FOR local_leitura IN
            SELECT DISTINCT "estacao" FROM "QualidadeAr"
            WHERE "sensorId" = origem."id" ORDER BY "estacao"
        LOOP
            IF primeira_estacao THEN
                UPDATE "SensorQualidadeAr" SET "estacao" = local_leitura."estacao" WHERE "id" = origem."id";
                primeira_estacao := FALSE;
            ELSE
                novo_nome := origem."nome" || ':estacao:' || local_leitura."estacao";
                -- Evita colisao com nomes que ja existiam antes da migracao.
                WHILE EXISTS (SELECT 1 FROM "SensorQualidadeAr" WHERE "nome" = novo_nome) LOOP
                    novo_nome := novo_nome || ':';
                END LOOP;
                INSERT INTO "SensorQualidadeAr" ("nome", "tipo", "estacao", "createdAt")
                VALUES (novo_nome, origem."tipo", local_leitura."estacao", origem."createdAt")
                RETURNING "id" INTO novo_sensor_id;

                UPDATE "QualidadeAr" SET "sensorId" = novo_sensor_id
                WHERE "sensorId" = origem."id" AND "estacao" = local_leitura."estacao";
            END IF;
        END LOOP;
        IF primeira_estacao THEN
            -- Equipamentos sem leituras ainda nao tinham um local registrado.
            UPDATE "SensorQualidadeAr" SET "estacao" = 'legado:sem-estacao' WHERE "id" = origem."id";
        END IF;
    END LOOP;
END;
$$;

ALTER TABLE "SensorQualidadeAr" ALTER COLUMN "estacao" SET NOT NULL;
ALTER TABLE "QualidadeAr" DROP COLUMN "estacao";

COMMIT;
