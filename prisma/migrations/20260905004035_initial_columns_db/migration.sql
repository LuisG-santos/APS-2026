-- CreateTable
CREATE TABLE "Alagamento" (
    "id" SERIAL NOT NULL,
    "sensor" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "nivelCorregoCm" DOUBLE PRECISION NOT NULL,
    "chuvaAcumuladaMm" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Alagamento_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QualidadeAr" (
    "id" SERIAL NOT NULL,
    "estacao" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "mp25" DOUBLE PRECISION NOT NULL,
    "co" DOUBLE PRECISION NOT NULL,
    "no3" DOUBLE PRECISION NOT NULL,
    "temperatura" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QualidadeAr_pkey" PRIMARY KEY ("id")
);

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