/*
  Warnings:

  - You are about to drop the column `generationNegativePrompt` on the `comics` table. All the data in the column will be lost.
  - You are about to drop the column `generationPrompt` on the `comics` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "comics" DROP COLUMN "generationNegativePrompt",
DROP COLUMN "generationPrompt";

-- AlterTable
ALTER TABLE "pages" ADD COLUMN     "pagePrompt" TEXT;
