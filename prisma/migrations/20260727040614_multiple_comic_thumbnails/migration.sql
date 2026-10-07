/*
  Warnings:

  - The `coverThumbnailUrl` column on the `comics` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- AlterTable
ALTER TABLE "comics" DROP COLUMN "coverThumbnailUrl",
ADD COLUMN     "coverThumbnailUrl" TEXT[] DEFAULT ARRAY[]::TEXT[];
