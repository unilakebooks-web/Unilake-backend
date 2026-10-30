-- CreateTable
CREATE TABLE "session_pages" (
    "orderSessionId" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "isPreviewPage" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_pages_pkey" PRIMARY KEY ("orderSessionId","pageId")
);

-- CreateIndex
CREATE INDEX "session_pages_pageId_idx" ON "session_pages"("pageId");

-- AddForeignKey
ALTER TABLE "session_pages" ADD CONSTRAINT "session_pages_orderSessionId_fkey" FOREIGN KEY ("orderSessionId") REFERENCES "order_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_pages" ADD CONSTRAINT "session_pages_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill every existing session with the pages its book was made from:
--   - every page of its comic that existed when the session was created, and
--   - any later page the session nonetheless already has a generated version
--     of, so nothing a customer can already see disappears from their book.
-- isPreviewPage takes the page's current value — the only one on record.
INSERT INTO "session_pages" ("orderSessionId", "pageId", "isPreviewPage")
SELECT os."id", p."id", p."isPreviewPage"
FROM "order_sessions" os
JOIN "pages" p ON p."comicId" = os."comicId"
WHERE p."createdAt" <= os."createdAt"
   OR EXISTS (
     SELECT 1
     FROM "page_versions" pv
     WHERE pv."orderSessionId" = os."id"
       AND pv."pageId" = p."id"
   )
ON CONFLICT DO NOTHING;
