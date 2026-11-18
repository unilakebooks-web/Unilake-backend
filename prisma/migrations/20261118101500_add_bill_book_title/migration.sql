-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "billBookTitle" TEXT;

-- Freeze the book title on every bill already issued, as the title is today, so a
-- later rename of a book does not change those bills. Only orders that have a bill
-- number; only where the column is still empty, so it is safe to run again. A raw
-- UPDATE leaves "updatedAt" alone.
UPDATE "orders" AS o
SET "billBookTitle" = c."title"
FROM "order_sessions" AS s
JOIN "comics" AS c ON c."id" = s."comicId"
WHERE s."id" = o."orderSessionId"
  AND o."billNumber" IS NOT NULL
  AND o."billBookTitle" IS NULL;
