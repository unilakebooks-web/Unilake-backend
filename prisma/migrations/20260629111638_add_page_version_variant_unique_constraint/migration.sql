/*
  Warnings:

  - A unique constraint covering the columns `[orderSessionId,pageNumber,variantIndex]` on the table `page_versions` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "page_versions_orderSessionId_pageNumber_variantIndex_key" ON "page_versions"("orderSessionId", "pageNumber", "variantIndex");
