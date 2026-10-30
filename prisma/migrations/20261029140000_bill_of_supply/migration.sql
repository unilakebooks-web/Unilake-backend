-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "billIssuedAt" TIMESTAMP(3),
ADD COLUMN     "billNumber" TEXT;

-- CreateTable
CREATE TABLE "bill_counters" (
    "financialYear" INTEGER NOT NULL,
    "lastSerial" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bill_counters_pkey" PRIMARY KEY ("financialYear")
);

-- CreateIndex
CREATE UNIQUE INDEX "orders_billNumber_key" ON "orders"("billNumber");
