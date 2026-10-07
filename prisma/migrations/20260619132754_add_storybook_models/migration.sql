-- CreateEnum
CREATE TYPE "GenderTag" AS ENUM ('BOY', 'GIRL', 'UNISEX');

-- CreateEnum
CREATE TYPE "ComicStatus" AS ENUM ('DRAFT', 'PUBLISHING', 'PUBLISHED', 'UNPUBLISHED');

-- CreateEnum
CREATE TYPE "OrderSessionStatus" AS ENUM ('CREATED', 'PHOTO_UPLOADED', 'GENERATING_PREVIEW', 'PREVIEW_READY', 'AWAITING_PAYMENT', 'PAID', 'GENERATING_PAID', 'PAID_PAGES_READY', 'CONFIRMED', 'GENERATING_HD', 'COMPILING_PDF', 'DISPATCHED', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "PronounKey" AS ENUM ('HE', 'SHE', 'THEY');

-- CreateEnum
CREATE TYPE "PageVersionStatus" AS ENUM ('QUEUED', 'GENERATING_SD', 'SD_READY', 'GENERATING_HD', 'HD_READY', 'FAILED');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('CREATED', 'PAID', 'GENERATING', 'CONFIRMED', 'PDF_READY', 'DISPATCHED', 'DELIVERED', 'FAILED', 'REFUNDED');

-- CreateTable
CREATE TABLE "comics" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "genderTag" "GenderTag" NOT NULL,
    "pageCount" INTEGER NOT NULL,
    "freePreviewPages" INTEGER NOT NULL,
    "coverThumbnailUrl" TEXT,
    "loraFileUrl" TEXT,
    "loraStrength" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "status" "ComicStatus" NOT NULL DEFAULT 'DRAFT',
    "basePrice" DECIMAL(10,2) NOT NULL,
    "baseCurrency" TEXT NOT NULL DEFAULT 'INR',
    "publishJobId" TEXT,
    "publishError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "comics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pages" (
    "id" TEXT NOT NULL,
    "comicId" TEXT NOT NULL,
    "pageNumber" INTEGER NOT NULL,
    "artworkUrl" TEXT,
    "maskUrl" TEXT,
    "hasFace" BOOLEAN NOT NULL DEFAULT false,
    "mirrorFace" BOOLEAN NOT NULL DEFAULT false,
    "faceDirection" TEXT,
    "isPreviewPage" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bubbles" (
    "id" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "x" DOUBLE PRECISION NOT NULL,
    "y" DOUBLE PRECISION NOT NULL,
    "width" DOUBLE PRECISION NOT NULL,
    "height" DOUBLE PRECISION NOT NULL,
    "dialogue" TEXT NOT NULL,
    "fontId" TEXT,
    "fontSize" INTEGER NOT NULL DEFAULT 24,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bubbles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fonts" (
    "id" TEXT NOT NULL,
    "comicId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fonts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pricing_rules" (
    "id" TEXT NOT NULL,
    "comicId" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "price" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pricing_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_sessions" (
    "id" TEXT NOT NULL,
    "comicId" TEXT NOT NULL,
    "childName" TEXT NOT NULL,
    "pronounKey" "PronounKey" NOT NULL,
    "status" "OrderSessionStatus" NOT NULL DEFAULT 'CREATED',
    "rawPhotoUrls" TEXT[],
    "bestPhotoUrl" TEXT,
    "photoScoreJson" JSONB,
    "shippingName" TEXT,
    "shippingLine1" TEXT,
    "shippingLine2" TEXT,
    "shippingCity" TEXT,
    "shippingState" TEXT,
    "shippingZip" TEXT,
    "shippingCountry" TEXT,
    "shippingPhone" TEXT,
    "wsRoomToken" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "page_versions" (
    "id" TEXT NOT NULL,
    "orderSessionId" TEXT NOT NULL,
    "pageNumber" INTEGER NOT NULL,
    "variantIndex" INTEGER NOT NULL DEFAULT 0,
    "seed" BIGINT,
    "comfyPromptId1" TEXT,
    "comfyPromptId2" TEXT,
    "comfyPromptId3" TEXT,
    "sdImageUrl" TEXT,
    "textRenderedUrl" TEXT,
    "hdImageUrl" TEXT,
    "isSelected" BOOLEAN NOT NULL DEFAULT false,
    "status" "PageVersionStatus" NOT NULL DEFAULT 'QUEUED',
    "errorMessage" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "page_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "orderSessionId" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "razorpayOrderId" TEXT,
    "razorpayPaymentId" TEXT,
    "status" "OrderStatus" NOT NULL DEFAULT 'CREATED',
    "pdfUrl" TEXT,
    "pdfDownloadUrl" TEXT,
    "pdfDownloadExpiry" TIMESTAMP(3),
    "shiprocketOrderId" TEXT,
    "awbNumber" TEXT,
    "courierName" TEXT,
    "trackingStatus" TEXT,
    "trackingUpdatedAt" TIMESTAMP(3),
    "isInternational" BOOLEAN NOT NULL DEFAULT false,
    "printVendorOrderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" TEXT NOT NULL,
    "orderId" TEXT,
    "source" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payloadJson" JSONB NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_config" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_config_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "pages_comicId_pageNumber_key" ON "pages"("comicId", "pageNumber");

-- CreateIndex
CREATE UNIQUE INDEX "pricing_rules_comicId_countryCode_key" ON "pricing_rules"("comicId", "countryCode");

-- CreateIndex
CREATE UNIQUE INDEX "order_sessions_wsRoomToken_key" ON "order_sessions"("wsRoomToken");

-- CreateIndex
CREATE INDEX "page_versions_orderSessionId_pageNumber_idx" ON "page_versions"("orderSessionId", "pageNumber");

-- CreateIndex
CREATE UNIQUE INDEX "orders_orderSessionId_key" ON "orders"("orderSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "orders_razorpayOrderId_key" ON "orders"("razorpayOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "orders_razorpayPaymentId_key" ON "orders"("razorpayPaymentId");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_eventId_key" ON "webhook_events"("eventId");

-- AddForeignKey
ALTER TABLE "pages" ADD CONSTRAINT "pages_comicId_fkey" FOREIGN KEY ("comicId") REFERENCES "comics"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bubbles" ADD CONSTRAINT "bubbles_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bubbles" ADD CONSTRAINT "bubbles_fontId_fkey" FOREIGN KEY ("fontId") REFERENCES "fonts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fonts" ADD CONSTRAINT "fonts_comicId_fkey" FOREIGN KEY ("comicId") REFERENCES "comics"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pricing_rules" ADD CONSTRAINT "pricing_rules_comicId_fkey" FOREIGN KEY ("comicId") REFERENCES "comics"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_sessions" ADD CONSTRAINT "order_sessions_comicId_fkey" FOREIGN KEY ("comicId") REFERENCES "comics"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "page_versions" ADD CONSTRAINT "page_versions_orderSessionId_fkey" FOREIGN KEY ("orderSessionId") REFERENCES "order_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_orderSessionId_fkey" FOREIGN KEY ("orderSessionId") REFERENCES "order_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
