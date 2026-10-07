-- AlterTable
ALTER TABLE "bubbles" ALTER COLUMN "fontSize" SET DEFAULT 0.02,
ALTER COLUMN "fontSize" SET DATA TYPE DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "pages" ADD COLUMN     "artworkHeight" INTEGER,
ADD COLUMN     "artworkWidth" INTEGER;
