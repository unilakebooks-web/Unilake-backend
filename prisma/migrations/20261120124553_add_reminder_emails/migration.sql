-- CreateEnum
CREATE TYPE "ReminderKind" AS ENUM ('PREVIEW_UNFINISHED', 'BOOK_NOT_SENT', 'REVIEW_REQUEST');

-- CreateEnum
CREATE TYPE "ReminderSendStatus" AS ENUM ('CLAIMED', 'SENT', 'FAILED', 'LOST');

-- CreateEnum
CREATE TYPE "BroadcastStatus" AS ENUM ('DRAFT', 'SENDING', 'SENT', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BroadcastAudience" AS ENUM ('OPTED_IN_ONLY', 'OPTED_IN_AND_CUSTOMERS');

-- CreateEnum
CREATE TYPE "BroadcastRecipientStatus" AS ENUM ('PENDING', 'CLAIMED', 'SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "UnsubscribeScope" AS ENUM ('GLOBAL', 'ORDER_REMINDER');

-- CreateTable
CREATE TABLE "reminder_settings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "previewEnabled" BOOLEAN NOT NULL DEFAULT false,
    "previewOffsetsHours" INTEGER[] DEFAULT ARRAY[3, 24, 96]::INTEGER[],
    "previewEffectiveFrom" TIMESTAMP(3),
    "bookEnabled" BOOLEAN NOT NULL DEFAULT false,
    "bookOffsetsHours" INTEGER[] DEFAULT ARRAY[24, 72, 168]::INTEGER[],
    "bookEffectiveFrom" TIMESTAMP(3),
    "reviewEnabled" BOOLEAN NOT NULL DEFAULT false,
    "reviewOffsetsHours" INTEGER[] DEFAULT ARRAY[168, 336]::INTEGER[],
    "reviewEffectiveFrom" TIMESTAMP(3),
    "googleReviewUrl" TEXT,
    "reminderCouponCode" TEXT,
    "previewDeletionDays" INTEGER,
    "dailyBudget" INTEGER NOT NULL DEFAULT 30,
    "reminderReserve" INTEGER NOT NULL DEFAULT 10,
    "perRunLimit" INTEGER NOT NULL DEFAULT 10,
    "windowStartHour" INTEGER NOT NULL DEFAULT 9,
    "windowEndHour" INTEGER NOT NULL DEFAULT 20,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reminder_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reminder_sends" (
    "id" TEXT NOT NULL,
    "kind" "ReminderKind" NOT NULL,
    "orderSessionId" TEXT NOT NULL,
    "offsetHours" INTEGER NOT NULL,
    "email" TEXT NOT NULL,
    "status" "ReminderSendStatus" NOT NULL DEFAULT 'CLAIMED',
    "providerMessageId" TEXT,
    "errorName" TEXT,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "reminder_sends_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reminder_stops" (
    "kind" "ReminderKind" NOT NULL,
    "orderSessionId" TEXT NOT NULL,
    "stoppedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reminder_stops_pkey" PRIMARY KEY ("kind","orderSessionId")
);

-- CreateTable
CREATE TABLE "broadcasts" (
    "id" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "heading" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "buttonText" TEXT,
    "buttonUrl" TEXT,
    "audience" "BroadcastAudience" NOT NULL DEFAULT 'OPTED_IN_ONLY',
    "status" "BroadcastStatus" NOT NULL DEFAULT 'DRAFT',
    "recipientCount" INTEGER NOT NULL DEFAULT 0,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "createdByEmail" TEXT NOT NULL,
    "sendStartedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "broadcasts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "broadcast_recipients" (
    "id" TEXT NOT NULL,
    "broadcastId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "status" "BroadcastRecipientStatus" NOT NULL DEFAULT 'PENDING',
    "providerMessageId" TEXT,
    "errorName" TEXT,
    "claimedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "broadcast_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_opt_outs" (
    "email" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_opt_outs_pkey" PRIMARY KEY ("email")
);

-- CreateTable
CREATE TABLE "email_unsubscribe_tokens" (
    "token" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "scope" "UnsubscribeScope" NOT NULL DEFAULT 'GLOBAL',
    "orderSessionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_unsubscribe_tokens_pkey" PRIMARY KEY ("token")
);

-- CreateTable
CREATE TABLE "marketing_consents" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "optedInAt" TIMESTAMP(3) NOT NULL,
    "withdrawnAt" TIMESTAMP(3),
    "wordingVersion" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "marketing_consents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reminder_sends_claimedAt_idx" ON "reminder_sends"("claimedAt");

-- CreateIndex
CREATE INDEX "reminder_sends_email_claimedAt_idx" ON "reminder_sends"("email", "claimedAt");

-- CreateIndex
CREATE UNIQUE INDEX "reminder_sends_kind_orderSessionId_offsetHours_key" ON "reminder_sends"("kind", "orderSessionId", "offsetHours");

-- CreateIndex
CREATE INDEX "broadcasts_status_createdAt_idx" ON "broadcasts"("status", "createdAt");

-- CreateIndex
CREATE INDEX "broadcast_recipients_broadcastId_status_idx" ON "broadcast_recipients"("broadcastId", "status");

-- CreateIndex
CREATE INDEX "broadcast_recipients_claimedAt_idx" ON "broadcast_recipients"("claimedAt");

-- CreateIndex
CREATE INDEX "broadcast_recipients_createdAt_idx" ON "broadcast_recipients"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "broadcast_recipients_broadcastId_email_key" ON "broadcast_recipients"("broadcastId", "email");

-- CreateIndex
CREATE INDEX "email_unsubscribe_tokens_createdAt_idx" ON "email_unsubscribe_tokens"("createdAt");

-- CreateIndex
CREATE INDEX "email_unsubscribe_tokens_email_idx" ON "email_unsubscribe_tokens"("email");

-- CreateIndex
CREATE UNIQUE INDEX "marketing_consents_userId_key" ON "marketing_consents"("userId");

-- AddForeignKey
ALTER TABLE "broadcast_recipients" ADD CONSTRAINT "broadcast_recipients_broadcastId_fkey" FOREIGN KEY ("broadcastId") REFERENCES "broadcasts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
