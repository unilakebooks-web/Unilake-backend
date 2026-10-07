-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "awbGeneratedAt" TIMESTAMP(3),
ADD COLUMN     "courierId" INTEGER,
ADD COLUMN     "deliveredAt" TIMESTAMP(3),
ADD COLUMN     "finalBreadth" DOUBLE PRECISION,
ADD COLUMN     "finalHeight" DOUBLE PRECISION,
ADD COLUMN     "finalLength" DOUBLE PRECISION,
ADD COLUMN     "finalWeight" DOUBLE PRECISION,
ADD COLUMN     "labelGeneratedAt" TIMESTAMP(3),
ADD COLUMN     "pickupGeneratedAt" TIMESTAMP(3),
ADD COLUMN     "pickupScheduledDate" TIMESTAMP(3),
ADD COLUMN     "shippedAt" TIMESTAMP(3),
ADD COLUMN     "shiprocketShipmentId" TEXT;
