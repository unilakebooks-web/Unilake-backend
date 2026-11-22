-- SEO: alt text for the picture on a Google review. Additive only: one new nullable column, no DROP,
-- nothing rewritten. The previous backend ignores it.

-- AlterTable
ALTER TABLE "google_reviews" ADD COLUMN "imageAlt" TEXT;
