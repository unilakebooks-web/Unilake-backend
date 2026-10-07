/*
  Warnings:

  - You are about to drop the column `ageGroup` on the `comics` table. All the data in the column will be lost.
  - You are about to drop the column `genderTag` on the `comics` table. All the data in the column will be lost.
  - You are about to drop the column `themeId` on the `comics` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "comics" DROP CONSTRAINT "comics_themeId_fkey";

-- AlterTable
ALTER TABLE "comics" DROP COLUMN "ageGroup",
DROP COLUMN "genderTag",
DROP COLUMN "themeId",
ADD COLUMN     "ageGroups" "AgeGroup"[] DEFAULT ARRAY[]::"AgeGroup"[],
ADD COLUMN     "genderTags" "GenderTag"[] DEFAULT ARRAY[]::"GenderTag"[];

-- CreateTable
CREATE TABLE "_ComicToTheme" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_ComicToTheme_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE INDEX "_ComicToTheme_B_index" ON "_ComicToTheme"("B");

-- AddForeignKey
ALTER TABLE "_ComicToTheme" ADD CONSTRAINT "_ComicToTheme_A_fkey" FOREIGN KEY ("A") REFERENCES "comics"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ComicToTheme" ADD CONSTRAINT "_ComicToTheme_B_fkey" FOREIGN KEY ("B") REFERENCES "themes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
