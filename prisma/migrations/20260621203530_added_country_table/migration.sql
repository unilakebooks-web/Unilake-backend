/*
  Warnings:

  - You are about to drop the column `countryCode` on the `pricing_rules` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[comicId,countryId]` on the table `pricing_rules` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `countryId` to the `pricing_rules` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "pricing_rules_comicId_countryCode_key";

-- AlterTable
ALTER TABLE "pricing_rules" DROP COLUMN "countryCode",
ADD COLUMN     "countryId" TEXT NOT NULL;

-- CreateTable
CREATE TABLE "Country" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "flagUrl" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Country_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Country_code_key" ON "Country"("code");

-- CreateIndex
CREATE UNIQUE INDEX "pricing_rules_comicId_countryId_key" ON "pricing_rules"("comicId", "countryId");

-- AddForeignKey
ALTER TABLE "pricing_rules" ADD CONSTRAINT "pricing_rules_countryId_fkey" FOREIGN KEY ("countryId") REFERENCES "Country"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
