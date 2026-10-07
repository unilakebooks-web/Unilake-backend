/*
  Warnings:

  - A unique constraint covering the columns `[comicId,countryId,coverType]` on the table `pricing_rules` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `coverType` to the `orders` table without a default value. This is not possible if the table is not empty.
  - Added the required column `coverType` to the `pricing_rules` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "CoverType" AS ENUM ('HARDCOVER', 'SOFTCOVER');

-- DropIndex
DROP INDEX "pricing_rules_comicId_countryId_key";

-- AlterTable
ALTER TABLE "order_sessions" ADD COLUMN     "coverType" "CoverType",
ADD COLUMN     "notificationEmail" TEXT,
ADD COLUMN     "userId" TEXT;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "coverType" "CoverType" NOT NULL,
ADD COLUMN     "notificationEmail" TEXT,
ADD COLUMN     "shippingCity" TEXT,
ADD COLUMN     "shippingCountry" TEXT,
ADD COLUMN     "shippingLine1" TEXT,
ADD COLUMN     "shippingLine2" TEXT,
ADD COLUMN     "shippingName" TEXT,
ADD COLUMN     "shippingPhone" TEXT,
ADD COLUMN     "shippingState" TEXT,
ADD COLUMN     "shippingZip" TEXT;

-- AlterTable
ALTER TABLE "pricing_rules" ADD COLUMN     "coverType" "CoverType" NOT NULL;

-- CreateTable
CREATE TABLE "saved_addresses" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "label" TEXT,
    "name" TEXT NOT NULL,
    "line1" TEXT NOT NULL,
    "line2" TEXT,
    "city" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "zip" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "saved_addresses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pricing_rules_comicId_countryId_coverType_key" ON "pricing_rules"("comicId", "countryId", "coverType");

-- AddForeignKey
ALTER TABLE "order_sessions" ADD CONSTRAINT "order_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_addresses" ADD CONSTRAINT "saved_addresses_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
