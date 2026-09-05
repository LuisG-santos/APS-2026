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
