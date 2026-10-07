-- CreateEnum
CREATE TYPE "AgeGroup" AS ENUM ('AGE_0_2', 'AGE_3_5', 'AGE_6_8', 'AGE_9_12');

-- AlterTable
ALTER TABLE "comics" ADD COLUMN     "ageGroup" "AgeGroup",
ADD COLUMN     "description" TEXT,
ADD COLUMN     "isBestseller" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "themeId" TEXT;

-- CreateTable
CREATE TABLE "themes" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "themes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "themes_name_key" ON "themes"("name");

-- AddForeignKey
ALTER TABLE "comics" ADD CONSTRAINT "comics_themeId_fkey" FOREIGN KEY ("themeId") REFERENCES "themes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
