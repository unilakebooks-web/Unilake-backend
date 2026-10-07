-- CreateEnum
CREATE TYPE "TextAlign" AS ENUM ('LEFT', 'CENTER', 'RIGHT');

-- CreateEnum
CREATE TYPE "TextVerticalAlign" AS ENUM ('TOP', 'MIDDLE', 'BOTTOM');

-- CreateEnum
CREATE TYPE "TextCase" AS ENUM ('AS_TYPED', 'UPPERCASE', 'LOWERCASE');

-- AlterTable
ALTER TABLE "bubbles" ADD COLUMN     "textAlign" "TextAlign" NOT NULL DEFAULT 'CENTER',
ADD COLUMN     "textCase" "TextCase" NOT NULL DEFAULT 'AS_TYPED',
ADD COLUMN     "textVerticalAlign" "TextVerticalAlign" NOT NULL DEFAULT 'MIDDLE';
