-- CreateEnum
CREATE TYPE "ComicFactPlacement" AS ENUM ('PRELOADER', 'GENERATING');

-- CreateTable
CREATE TABLE "comic_facts" (
    "id" TEXT NOT NULL,
    "comicId" TEXT NOT NULL,
    "placement" "ComicFactPlacement" NOT NULL,
    "text" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "comic_facts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "comic_facts_comicId_placement_isActive_idx" ON "comic_facts"("comicId", "placement", "isActive");

-- AddForeignKey
ALTER TABLE "comic_facts" ADD CONSTRAINT "comic_facts_comicId_fkey" FOREIGN KEY ("comicId") REFERENCES "comics"("id") ON DELETE CASCADE ON UPDATE CASCADE;
