-- AlterTable
ALTER TABLE "comics" ADD COLUMN     "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- Number the existing comics in exactly the order the public list uses today
-- (bestsellers first, then newest first). The window covers every status, so
-- the published books keep their relative order. "id" only breaks exact ties,
-- which the old query left to chance. A raw UPDATE leaves "updatedAt" alone.
-- Run once, before the admin arranges anything; never re-run it afterwards.
UPDATE "comics" AS c
SET "sortOrder" = r.pos
FROM (
  SELECT "id",
         (ROW_NUMBER() OVER (ORDER BY "isBestseller" DESC, "createdAt" DESC, "id") - 1)::integer AS pos
  FROM "comics"
) AS r
WHERE c."id" = r."id";
