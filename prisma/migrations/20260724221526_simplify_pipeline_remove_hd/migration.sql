/*
  Warnings:

  - The values [GENERATING_HD] on the enum `OrderSessionStatus` will be removed. If these variants are still used in the database, this will fail.
  - The values [GENERATING_HD,HD_READY] on the enum `PageVersionStatus` will be removed. If these variants are still used in the database, this will fail.
  - You are about to drop the column `comfyPromptId1` on the `page_versions` table. All the data in the column will be lost.
  - You are about to drop the column `comfyPromptId2` on the `page_versions` table. All the data in the column will be lost.
  - You are about to drop the column `comfyPromptId3` on the `page_versions` table. All the data in the column will be lost.
  - You are about to drop the column `hdImageUrl` on the `page_versions` table. All the data in the column will be lost.
  - You are about to drop the column `sdImageUrl` on the `page_versions` table. All the data in the column will be lost.
  - You are about to drop the column `textRenderedUrl` on the `page_versions` table. All the data in the column will be lost.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "OrderSessionStatus_new" AS ENUM ('CREATED', 'PHOTO_UPLOADED', 'GENERATING_PREVIEW', 'PREVIEW_READY', 'AWAITING_PAYMENT', 'PAID', 'GENERATING_PAID', 'PAID_PAGES_READY', 'CONFIRMED', 'COMPILING_PDF', 'DISPATCHED', 'COMPLETED', 'FAILED');
ALTER TABLE "public"."order_sessions" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "order_sessions" ALTER COLUMN "status" TYPE "OrderSessionStatus_new" USING ("status"::text::"OrderSessionStatus_new");
ALTER TYPE "OrderSessionStatus" RENAME TO "OrderSessionStatus_old";
ALTER TYPE "OrderSessionStatus_new" RENAME TO "OrderSessionStatus";
DROP TYPE "public"."OrderSessionStatus_old";
ALTER TABLE "order_sessions" ALTER COLUMN "status" SET DEFAULT 'CREATED';
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "PageVersionStatus_new" AS ENUM ('QUEUED', 'TEXT_STAMPING', 'TEXT_STAMPED', 'GENERATING_SD', 'SD_READY', 'FAILED');
ALTER TABLE "public"."page_versions" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "page_versions" ALTER COLUMN "status" TYPE "PageVersionStatus_new" USING ("status"::text::"PageVersionStatus_new");
ALTER TYPE "PageVersionStatus" RENAME TO "PageVersionStatus_old";
ALTER TYPE "PageVersionStatus_new" RENAME TO "PageVersionStatus";
DROP TYPE "public"."PageVersionStatus_old";
ALTER TABLE "page_versions" ALTER COLUMN "status" SET DEFAULT 'QUEUED';
COMMIT;

-- AlterTable
ALTER TABLE "page_versions" DROP COLUMN "comfyPromptId1",
DROP COLUMN "comfyPromptId2",
DROP COLUMN "comfyPromptId3",
DROP COLUMN "hdImageUrl",
DROP COLUMN "sdImageUrl",
DROP COLUMN "textRenderedUrl",
ADD COLUMN     "comfyJobId" TEXT,
ADD COLUMN     "finalImageUrl" TEXT,
ADD COLUMN     "textStampedUrl" TEXT;
