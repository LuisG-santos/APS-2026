CREATE TYPE "DominioAlerta" AS ENUM ('ALAGAMENTO', 'QUALIDADE_AR', 'TRANSITO');

CREATE TABLE "TarefaAlerta" (
    "id" SERIAL NOT NULL,
    "dominio" "DominioAlerta" NOT NULL,
    "leituraId" INTEGER NOT NULL,
    "sensorId" INTEGER NOT NULL,
    "valor" DOUBLE PRECISION NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TarefaAlerta_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Alerta" (
    "id" SERIAL NOT NULL,
    "dominio" "DominioAlerta" NOT NULL,
    "leituraId" INTEGER NOT NULL,
    "sensorId" INTEGER NOT NULL,
    "valor" DOUBLE PRECISION NOT NULL,
    "limite" DOUBLE PRECISION NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Alerta_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TarefaAlerta_dominio_leituraId_key" ON "TarefaAlerta"("dominio", "leituraId");
CREATE UNIQUE INDEX "Alerta_dominio_leituraId_key" ON "Alerta"("dominio", "leituraId");
CREATE INDEX "Alerta_dominio_sensorId_timestamp_idx" ON "Alerta"("dominio", "sensorId", "timestamp");
