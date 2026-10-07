/*
  Warnings:

  - You are about to drop the column `coverThumbnailUrl` on the `comics` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "comics" DROP COLUMN "coverThumbnailUrl",
ADD COLUMN     "coverThumbnailUrls" TEXT[] DEFAULT ARRAY[]::TEXT[];
