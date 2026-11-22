-- Feature 13 (SEO). Additive only: new nullable columns, new tables, no DROP, nothing rewritten.
-- The comic slug column stays nullable on purpose: the previous backend creates comics without one
-- while a release is half deployed or rolled back. The service always fills it.

-- CreateEnum
CREATE TYPE "PageSeoSlug" AS ENUM ('HOME', 'COMICS', 'HOW_IT_WORKS', 'BLOGS', 'CONTACT', 'TEAM', 'ABOUT', 'PRIVACY', 'TERMS', 'REFUND');

-- AlterTable
ALTER TABLE "comics" ADD COLUMN     "coverThumbnailAlts" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "ogDescription" TEXT,
ADD COLUMN     "ogImageUrl" TEXT,
ADD COLUMN     "ogTitle" TEXT,
ADD COLUMN     "slug" TEXT;

-- AlterTable
ALTER TABLE "hero_images" ADD COLUMN     "imageAlt" TEXT;

-- AlterTable
ALTER TABLE "team_members" ADD COLUMN     "imageAlt" TEXT;

-- AlterTable
ALTER TABLE "how_it_works" ADD COLUMN     "posterAlt" TEXT;

-- AlterTable
ALTER TABLE "blogs" ADD COLUMN     "contentUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "coverImageAlt" TEXT,
ADD COLUMN     "ogDescription" TEXT,
ADD COLUMN     "ogImageUrl" TEXT,
ADD COLUMN     "ogTitle" TEXT,
ADD COLUMN     "publishedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "site_settings" ADD COLUMN     "blogAuthorInstagramUrl" TEXT,
ADD COLUMN     "blogAuthorLinkedinUrl" TEXT,
ADD COLUMN     "blogAuthorName" TEXT;

-- CreateTable
CREATE TABLE "comic_slug_history" (
    "id" TEXT NOT NULL,
    "oldSlug" TEXT NOT NULL,
    "comicId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "comic_slug_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blog_comics" (
    "blogId" TEXT NOT NULL,
    "comicId" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "blog_comics_pkey" PRIMARY KEY ("blogId","comicId")
);

-- CreateTable
CREATE TABLE "page_seo" (
    "id" TEXT NOT NULL,
    "slug" "PageSeoSlug" NOT NULL,
    "metaTitle" TEXT,
    "metaDescription" TEXT,
    "ogTitle" TEXT,
    "ogDescription" TEXT,
    "ogImageUrl" TEXT,
    "ogImageAlt" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "page_seo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "comic_slug_history_oldSlug_key" ON "comic_slug_history"("oldSlug");

-- CreateIndex
CREATE INDEX "comic_slug_history_comicId_idx" ON "comic_slug_history"("comicId");

-- CreateIndex
CREATE INDEX "blog_comics_comicId_idx" ON "blog_comics"("comicId");

-- CreateIndex
CREATE UNIQUE INDEX "page_seo_slug_key" ON "page_seo"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "comics_slug_key" ON "comics"("slug");

-- AddForeignKey
ALTER TABLE "comic_slug_history" ADD CONSTRAINT "comic_slug_history_comicId_fkey" FOREIGN KEY ("comicId") REFERENCES "comics"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blog_comics" ADD CONSTRAINT "blog_comics_blogId_fkey" FOREIGN KEY ("blogId") REFERENCES "blogs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blog_comics" ADD CONSTRAINT "blog_comics_comicId_fkey" FOREIGN KEY ("comicId") REFERENCES "comics"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill 1: a readable slug for every existing comic, from its title. Lower case, runs of other
-- characters become one hyphen, at most 80 characters, "comic" when nothing is left (for example a
-- title with no Latin letters), duplicates numbered -2, -3 in creation order. The admin can edit them.
WITH base AS (
  SELECT id, "createdAt",
    COALESCE(
      NULLIF(trim(both '-' from left(trim(both '-' from regexp_replace(lower(title), '[^a-z0-9]+', '-', 'g')), 80)), ''),
      'comic'
    ) AS s
  FROM comics
), numbered AS (
  SELECT id, s, row_number() OVER (PARTITION BY s ORDER BY "createdAt", id) AS n FROM base
)
UPDATE comics c
SET slug = CASE WHEN numbered.n = 1 THEN numbered.s ELSE numbered.s || '-' || numbered.n END
FROM numbered
WHERE c.id = numbered.id AND c.slug IS NULL;

-- Backfill 2: a post that is live today was published no later than it was created.
UPDATE blogs SET "publishedAt" = "createdAt" WHERE "isActive" = true AND "publishedAt" IS NULL;
