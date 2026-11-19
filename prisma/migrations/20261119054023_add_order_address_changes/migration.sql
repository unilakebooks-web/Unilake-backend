-- CreateEnum
CREATE TYPE "AddressSyncStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'SYNCING', 'SYNCED', 'FAILED', 'UNVERIFIED', 'MANUAL');

-- CreateTable
CREATE TABLE "order_address_changes" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "seq" SERIAL NOT NULL,
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,
    "changedById" TEXT NOT NULL,
    "changedByEmail" TEXT NOT NULL,
    "syncStatus" "AddressSyncStatus" NOT NULL,
    "syncError" TEXT,
    "syncNote" TEXT,
    "syncStartedAt" TIMESTAMP(3),
    "syncedAt" TIMESTAMP(3),
    "syncedById" TEXT,
    "syncedByEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_address_changes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "order_address_changes_orderId_seq_idx" ON "order_address_changes"("orderId", "seq");

-- AddForeignKey
ALTER TABLE "order_address_changes" ADD CONSTRAINT "order_address_changes_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
