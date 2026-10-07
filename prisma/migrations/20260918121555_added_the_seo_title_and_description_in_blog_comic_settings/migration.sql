-- AlterTable
ALTER TABLE "blogs" ADD COLUMN     "metaDescription" TEXT,
ADD COLUMN     "metaTitle" TEXT;

-- AlterTable
ALTER TABLE "comics" ADD COLUMN     "metaDescription" TEXT,
ADD COLUMN     "metaTitle" TEXT;

-- AlterTable
ALTER TABLE "site_settings" ADD COLUMN     "metaDescription" TEXT,
ADD COLUMN     "metaTitle" TEXT;
