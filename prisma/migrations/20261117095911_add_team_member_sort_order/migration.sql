-- AlterTable
ALTER TABLE "team_members" ADD COLUMN     "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- Number the existing members in exactly the order the Team page shows today
-- (newest first, hidden members included). "id" only breaks exact ties, which the
-- old query left to chance. A raw UPDATE leaves "updatedAt" alone.
UPDATE "team_members" AS t
SET "sortOrder" = r.pos
FROM (
  SELECT "id",
         (ROW_NUMBER() OVER (ORDER BY "createdAt" DESC, "id") - 1)::integer AS pos
  FROM "team_members"
) AS r
WHERE t."id" = r."id";
