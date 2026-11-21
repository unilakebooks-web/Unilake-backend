-- CreateEnum
CREATE TYPE "DeletionGroup" AS ENUM ('PREVIEWS', 'PHOTOS', 'BOOKS');

-- CreateEnum
CREATE TYPE "DeletionMode" AS ENUM ('OFF', 'REPORT_ONLY', 'ACTIVE');

-- CreateEnum
CREATE TYPE "DeletionScope" AS ENUM ('SESSION', 'PHOTO', 'PAGES', 'PDF', 'ADDRESS', 'COMIC');

-- CreateEnum
CREATE TYPE "DeletionSubjectType" AS ENUM ('SESSION', 'ORDER', 'COMIC');

-- CreateEnum
CREATE TYPE "DeletionItemState" AS ENUM ('CLAIMED', 'DONE', 'FAILED');

-- AlterTable
ALTER TABLE "comics" ADD COLUMN     "filesDeletedAt" TIMESTAMP(3),
ADD COLUMN     "retiredAt" TIMESTAMP(3),
ADD COLUMN     "unpublishedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "order_sessions" ADD COLUMN     "filesDeletedAt" TIMESTAMP(3),
ADD COLUMN     "photoDeletedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "paidAfterDeletionAt" TIMESTAMP(3),
ADD COLUMN     "pdfDeletedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "deletion_group_settings" (
    "group" "DeletionGroup" NOT NULL,
    "mode" "DeletionMode" NOT NULL DEFAULT 'REPORT_ONLY',
    "dailyMax" INTEGER NOT NULL DEFAULT 100,
    "lastRunAt" TIMESTAMP(3),
    "lastReportAt" TIMESTAMP(3),
    "approvedRunId" TEXT,
    "approvedSelectionVersion" INTEGER,
    "approvedAt" TIMESTAMP(3),
    "approvalExhaustedAt" TIMESTAMP(3),
    "modeChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "modeChangedByEmail" TEXT,
    "pausedReason" TEXT,
    "pausedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deletion_group_settings_pkey" PRIMARY KEY ("group")
);

-- CreateTable
CREATE TABLE "deletion_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "canaryPassedAt" TIMESTAMP(3),
    "canaryAttemptedAt" TIMESTAMP(3),
    "canaryAttemptsDay" TEXT,
    "canaryAttempts" INTEGER NOT NULL DEFAULT 0,
    "canaryAutoEnabled" BOOLEAN NOT NULL DEFAULT false,
    "leaseUntil" TIMESTAMP(3),
    "leaseOwner" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deletion_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deletion_runs" (
    "id" TEXT NOT NULL,
    "group" "DeletionGroup" NOT NULL,
    "mode" "DeletionMode" NOT NULL,
    "selectionVersion" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "dueCount" INTEGER NOT NULL DEFAULT 0,
    "claimedCount" INTEGER NOT NULL DEFAULT 0,
    "deletedCount" INTEGER NOT NULL DEFAULT 0,
    "ghostCount" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "objectCounts" JSONB,
    "proof" JSONB,
    "lists" JSONB,
    "note" TEXT,

    CONSTRAINT "deletion_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deletion_items" (
    "id" TEXT NOT NULL,
    "subjectType" "DeletionSubjectType" NOT NULL,
    "subjectId" TEXT NOT NULL,
    "scope" "DeletionScope" NOT NULL,
    "state" "DeletionItemState" NOT NULL DEFAULT 'CLAIMED',
    "preCount" JSONB,
    "ghost" BOOLEAN NOT NULL DEFAULT false,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "lastErrorAt" TIMESTAMP(3),
    "lastError" TEXT,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "doneAt" TIMESTAMP(3),
    "reverifiedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deletion_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deletion_blocks" (
    "subjectId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deletion_blocks_pkey" PRIMARY KEY ("subjectId")
);

-- CreateIndex
CREATE INDEX "deletion_runs_group_startedAt_idx" ON "deletion_runs"("group", "startedAt");

-- CreateIndex
CREATE INDEX "deletion_items_state_updatedAt_idx" ON "deletion_items"("state", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "deletion_items_subjectId_scope_key" ON "deletion_items"("subjectId", "scope");

-- CreateIndex
CREATE INDEX "order_sessions_filesDeletedAt_expiresAt_idx" ON "order_sessions"("filesDeletedAt", "expiresAt");

-- CreateIndex
CREATE INDEX "orders_status_deliveredAt_idx" ON "orders"("status", "deliveredAt");

-- The settings table holds exactly one row, id 1.
ALTER TABLE "deletion_settings" ADD CONSTRAINT "deletion_settings_singleton" CHECK ("id" = 1);

-- Seed: the singleton and one row per group. Every group starts in REPORT_ONLY (deletes nothing).
INSERT INTO "deletion_settings" ("id", "updatedAt") VALUES (1, now() AT TIME ZONE 'UTC');
INSERT INTO "deletion_group_settings" ("group", "updatedAt") VALUES
  ('PREVIEWS', now() AT TIME ZONE 'UTC'),
  ('PHOTOS', now() AT TIME ZONE 'UTC'),
  ('BOOKS', now() AT TIME ZONE 'UTC');

-- Comics that are already unpublished start their one-month wait now (a null date is never eligible).
UPDATE "comics" SET "unpublishedAt" = now() AT TIME ZONE 'UTC' WHERE "status" = 'UNPUBLISHED' AND "unpublishedAt" IS NULL;
