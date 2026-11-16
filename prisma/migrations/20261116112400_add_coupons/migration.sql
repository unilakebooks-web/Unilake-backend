-- CreateEnum
CREATE TYPE "CouponDiscountType" AS ENUM ('PERCENT', 'FIXED');

-- CreateEnum
CREATE TYPE "CouponKind" AS ENUM ('PUBLIC', 'SINGLE_USE');

-- CreateEnum
CREATE TYPE "CouponRedemptionStatus" AS ENUM ('RESERVED', 'REDEEMED', 'RELEASED');

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "couponCode" TEXT,
ADD COLUMN     "discountAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "listAmount" DECIMAL(10,2),
ADD COLUMN     "supersededRazorpayOrderIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "coupons" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "kind" "CouponKind" NOT NULL DEFAULT 'PUBLIC',
    "discountType" "CouponDiscountType" NOT NULL,
    "percentOff" DECIMAL(5,2),
    "amountOff" DECIMAL(10,2),
    "maxDiscount" DECIMAL(10,2),
    "currency" TEXT,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "usageLimit" INTEGER,
    "perCustomerLimit" INTEGER,
    "restrictedToUserId" TEXT,
    "allComics" BOOLEAN NOT NULL DEFAULT true,
    "countryCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "coverTypes" "CoverType"[] DEFAULT ARRAY[]::"CoverType"[],
    "combinable" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coupons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coupon_comics" (
    "couponId" TEXT NOT NULL,
    "comicId" TEXT NOT NULL,

    CONSTRAINT "coupon_comics_pkey" PRIMARY KEY ("couponId","comicId")
);

-- CreateTable
CREATE TABLE "coupon_redemptions" (
    "id" TEXT NOT NULL,
    "couponId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "CouponRedemptionStatus" NOT NULL DEFAULT 'RESERVED',
    "discountAmount" DECIMAL(10,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "redeemedAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "releaseReason" TEXT,

    CONSTRAINT "coupon_redemptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "coupons_code_key" ON "coupons"("code");

-- CreateIndex
CREATE INDEX "coupons_isActive_endsAt_idx" ON "coupons"("isActive", "endsAt");

-- CreateIndex
CREATE INDEX "coupon_comics_comicId_idx" ON "coupon_comics"("comicId");

-- CreateIndex
CREATE UNIQUE INDEX "coupon_redemptions_orderId_key" ON "coupon_redemptions"("orderId");

-- CreateIndex
CREATE INDEX "coupon_redemptions_couponId_status_createdAt_idx" ON "coupon_redemptions"("couponId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "coupon_redemptions_couponId_userId_idx" ON "coupon_redemptions"("couponId", "userId");

-- Safety net for the money rules. The service validates first; these make the
-- database refuse an impossible coupon even if a bug or a manual edit slips
-- one through. Prisma does not model CHECK constraints, so they live only here.
ALTER TABLE "coupons"
  ADD CONSTRAINT "coupons_code_format_chk" CHECK ("code" ~ '^[A-Z0-9-]{4,32}$'),
  ADD CONSTRAINT "coupons_discount_shape_chk" CHECK (
    ("discountType" = 'PERCENT' AND "percentOff" IS NOT NULL AND "percentOff" > 0 AND "percentOff" <= 100 AND "amountOff" IS NULL)
    OR
    ("discountType" = 'FIXED' AND "amountOff" IS NOT NULL AND "amountOff" > 0 AND "percentOff" IS NULL AND "maxDiscount" IS NULL)
  ),
  ADD CONSTRAINT "coupons_max_discount_chk" CHECK ("maxDiscount" IS NULL OR "maxDiscount" > 0),
  -- an amount only means something in one currency: fixed and capped coupons need one
  ADD CONSTRAINT "coupons_currency_required_chk" CHECK (
    ("discountType" = 'PERCENT' AND "maxDiscount" IS NULL) OR "currency" IS NOT NULL
  ),
  ADD CONSTRAINT "coupons_currency_format_chk" CHECK ("currency" IS NULL OR "currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "coupons_limits_chk" CHECK (
    ("usageLimit" IS NULL OR "usageLimit" > 0) AND ("perCustomerLimit" IS NULL OR "perCustomerLimit" > 0)
  ),
  ADD CONSTRAINT "coupons_dates_chk" CHECK ("startsAt" IS NULL OR "endsAt" IS NULL OR "endsAt" > "startsAt");

ALTER TABLE "coupon_redemptions"
  ADD CONSTRAINT "coupon_redemptions_amount_chk" CHECK ("discountAmount" >= 0);

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_discount_chk" CHECK ("discountAmount" >= 0);

-- AddForeignKey
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_restrictedToUserId_fkey" FOREIGN KEY ("restrictedToUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupon_comics" ADD CONSTRAINT "coupon_comics_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "coupons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupon_comics" ADD CONSTRAINT "coupon_comics_comicId_fkey" FOREIGN KEY ("comicId") REFERENCES "comics"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "coupons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
