-- Feature 13 (SEO): a fourth editable page, About. A new enum value can not be used in the
-- transaction that adds it, so this is a migration of its own and contains nothing else.
ALTER TYPE "SitePageSlug" ADD VALUE IF NOT EXISTS 'ABOUT';
