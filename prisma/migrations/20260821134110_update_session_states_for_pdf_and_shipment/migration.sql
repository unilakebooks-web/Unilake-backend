/*
  Warnings:

  - The values [DISPATCHED] on the enum `OrderSessionStatus` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "OrderSessionStatus_new" AS ENUM ('CREATED', 'PHOTO_UPLOADED', 'GENERATING_PREVIEW', 'PREVIEW_READY', 'AWAITING_PAYMENT', 'PAID', 'GENERATING_PAID', 'PAID_PAGES_READY', 'CONFIRMED', 'COMPILING_PDF', 'PDF_FAILED', 'SHIPMENT_QUEUED', 'SHIPMENT_FAILED', 'COMPLETED', 'FAILED');
ALTER TABLE "public"."order_sessions" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "order_sessions" ALTER COLUMN "status" TYPE "OrderSessionStatus_new" USING ("status"::text::"OrderSessionStatus_new");
ALTER TYPE "OrderSessionStatus" RENAME TO "OrderSessionStatus_old";
ALTER TYPE "OrderSessionStatus_new" RENAME TO "OrderSessionStatus";
DROP TYPE "public"."OrderSessionStatus_old";
ALTER TABLE "order_sessions" ALTER COLUMN "status" SET DEFAULT 'CREATED';
COMMIT;
