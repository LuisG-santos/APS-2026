-- CreateTable
CREATE TABLE "Transito" (
    "id" SERIAL NOT NULL,
    "veiculo" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "posicao" TEXT NOT NULL,
    "velocidade" DOUBLE PRECISION NOT NULL,
    "ocupacao" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Transito_pkey" PRIMARY KEY ("id")
);
