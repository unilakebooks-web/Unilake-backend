-- A public Reviews page with its own search and share text. A new enum value can not be used in
-- the transaction that adds it, so this is a migration of its own and contains nothing else.
ALTER TYPE "PageSeoSlug" ADD VALUE IF NOT EXISTS 'REVIEWS';
