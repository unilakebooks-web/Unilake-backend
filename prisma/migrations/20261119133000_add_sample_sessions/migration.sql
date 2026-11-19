-- AlterTable
ALTER TABLE "order_sessions" ADD COLUMN     "isSample" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "order_sessions_isSample_expiresAt_idx" ON "order_sessions"("isSample", "expiresAt");
