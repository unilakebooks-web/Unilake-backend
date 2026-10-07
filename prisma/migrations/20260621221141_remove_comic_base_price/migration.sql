/*
  Warnings:

  - You are about to drop the column `baseCurrency` on the `comics` table. All the data in the column will be lost.
  - You are about to drop the column `basePrice` on the `comics` table. All the data in the column will be lost.
  - You are about to drop the column `currency` on the `pricing_rules` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "comics" DROP COLUMN "baseCurrency",
DROP COLUMN "basePrice";

-- AlterTable
ALTER TABLE "pricing_rules" DROP COLUMN "currency";
