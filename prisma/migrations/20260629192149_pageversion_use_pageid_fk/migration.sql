/*
  Warnings:

  - You are about to drop the column `pageNumber` on the `page_versions` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[orderSessionId,pageId,variantIndex]` on the table `page_versions` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `pageId` to the `page_versions` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "page_versions_orderSessionId_pageNumber_idx";

-- DropIndex
DROP INDEX "page_versions_orderSessionId_pageNumber_variantIndex_key";

-- AlterTable
ALTER TABLE "page_versions" DROP COLUMN "pageNumber",
ADD COLUMN     "pageId" TEXT NOT NULL;

-- CreateIndex
CREATE INDEX "page_versions_orderSessionId_pageId_idx" ON "page_versions"("orderSessionId", "pageId");

-- CreateIndex
CREATE UNIQUE INDEX "page_versions_orderSessionId_pageId_variantIndex_key" ON "page_versions"("orderSessionId", "pageId", "variantIndex");

-- AddForeignKey
ALTER TABLE "page_versions" ADD CONSTRAINT "page_versions_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "pages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
