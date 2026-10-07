// src/routes/admin.ts
import { Router } from "express";
import {
  createComicHandler,
  deleteComicHandler,
  getAdminComicsHandler,
  getAdminComicDetailHandler,
  getComicPricingHandler,
  getLoraUploadUrlHandler,
  updateComicHandler,
  updateComicPricingHandler,
  updateComicStatusHandler,
  getThumbnailUploadUrlsBatchHandler,
  getComicVideoUploadUrlHandler,
} from "../controllers/comic.controller.js";
import {
  createCountryHandler,
  deleteCountryHandler,
  getAllCountriesHandler,
  getFlagUploadUrlHandler,
  updateCountryHandler,
} from "../controllers/country.controller.js";
import { validateBody } from "../middlewares/validateBody.js";
import {
  createComicSchema,
  getComicVideoUploadUrlSchema,
  getLoraUploadUrlSchema,
  updateComicPricingSchema,
  updateComicSchema,
  updateComicStatusSchema,
} from "../validators/comic.schema.js";
import {
  createPageSchema,
  getPageArtworkUploadUrlSchema,
  updatePageSchema,
  reorderPagesSchema,
  previewPageStampSchema
} from "../validators/page.schema.js";
import {
  createPageHandler,
  getPageArtworkUploadUrlHandler,
  listComicPagesHandler,
  updatePageHandler,
  deletePageHandler,
  reorderPagesHandler,
  previewPageStampHandler
} from "../controllers/page.controller.js";
import {
  createBubbleSchema,
  updateBubbleSchema,
} from "../validators/bubble.schema.js";
import {
  createBubbleHandler,
  listPageBubblesHandler,
  updateBubbleHandler,
  deleteBubbleHandler,
} from "../controllers/bubble.controller.js";
import {
  getFontUploadUrlHandler,
  createFontHandler,
  listComicFontsHandler,
  updateFontHandler,
  deleteFontHandler,
  getFontFileHandler,
} from "../controllers/font.controller.js";
import {
  getFontUploadUrlSchema,
  createFontSchema,
  updateFontSchema,
} from "../validators/font.schema.js";
import {
  createThemeSchema,
  updateThemeSchema,
} from "../validators/theme.schema.js";
import {
  createThemeHandler,
  deleteThemeHandler,
  updateThemeHandler,
} from "../controllers/theme.controller.js";
import {
  createAnnouncementSchema,
  reorderAnnouncementsSchema,
  updateAnnouncementSchema,
} from "../validators/announcement.schema.js";
import {
  createAnnouncementHandler,
  deleteAnnouncementHandler,
  listAnnouncementsHandler,
  reorderAnnouncementsHandler,
  toggleAnnouncementStatusHandler,
  updateAnnouncementHandler,
} from "../controllers/announcement.controller.js";
import {
  createHeroImageSchema,
  getHeroImageUploadUrlSchema,
} from "../validators/heroImage.schema.js";
import {
  createHeroImageHandler,
  deleteHeroImageHandler,
  getAllHeroImagesHandler,
  getHeroImageUploadUrlHandler,
  toggleHeroImageStatusHandler,
} from "../controllers/heroImage.controller.js";
import {
  createCustomerReviewSchema,
  getCustomerReviewUploadUrlSchema,
} from "../validators/customerReview.schema.js";
import {
  createCustomerReviewHandler,
  deleteCustomerReviewHandler,
  getAllCustomerReviewsHandler,
  getCustomerReviewUploadUrlHandler,
  toggleCustomerReviewStatusHandler,
} from "../controllers/customerReview.controller.js";
import {
  createTeamMemberSchema,
  getTeamMemberUploadUrlSchema,
  updateTeamMemberSchema,
} from "../validators/teamMember.schema.js";
import {
  createTeamMemberHandler,
  deleteTeamMemberHandler,
  getActiveTeamMembersHandler,
  getAllTeamMembersHandler,
  getTeamMemberUploadUrlHandler,
  toggleTeamMemberStatusHandler,
  updateTeamMemberHandler,
} from "../controllers/teamMember.controller.js";
import {
  deleteFeedbackHandler,
  getAllFeedbacksHandler,
  updateFeedbackStatusHandler,
} from "../controllers/feedback.controller.js";
import { updateFeedbackStatusSchema } from "../validators/feedback.schema.js";
import {
  deleteContactEnquiryHandler,
  getAllContactEnquiriesHandler,
  updateContactEnquiryStatusHandler,
} from "../controllers/contactEnquiry.controller.js";
import { updateContactEnquiryStatusSchema } from "../validators/contactEnquiry.schema.js";
import {
  getHowItWorksUploadUrlSchema,
  updateHowItWorksSchema,
} from "../validators/howItWorks.schema.js";
import {
  getAdminHowItWorksHandler,
  getHowItWorksUploadUrlHandler,
  updateHowItWorksHandler,
} from "../controllers/howItWorks.controller.js";
import {
  createFaqSchema,
  reorderFaqsSchema,
  updateFaqSchema,
} from "../validators/faq.schema.js";
import {
  createFaqHandler,
  deleteFaqHandler,
  getAllFaqsHandler,
  reorderFaqsHandler,
  toggleFaqStatusHandler,
  updateFaqHandler,
} from "../controllers/faq.controller.js";
import {
  createBlogSchema,
  getBlogUploadUrlSchema,
  updateBlogSchema,
} from "../validators/blog.schema.js";
import {
  createBlogHandler,
  deleteBlogHandler,
  getAdminBlogByIdHandler,
  getAdminBlogsHandler,
  getBlogUploadUrlHandler,
  toggleBlogStatusHandler,
  updateBlogHandler,
} from "../controllers/blog.controller.js";
import { listAdminOrdersHandler, getAdminOrderDetailHandler, confirmDimensionsHandler, retryShiprocketHandler, getOrderLabelHandler,  refreshTrackingHandler} from "../controllers/order.controller.js";
import { confirmDimensionsBodySchema } from "../validators/order.schema.js";
import {
  getAdminSitePageHandler,
  getAdminSitePagesHandler,
  toggleSitePageStatusHandler,
  upsertSitePageHandler,
} from "../controllers/sitePage.controller.js";
import { upsertSitePageSchema } from "../validators/sitePage.schema.js";
import {
  getAdminSiteSettingHandler,
  updateSiteSettingHandler,
} from "../controllers/siteSetting.controller.js";
import { updateSiteSettingSchema } from "../validators/siteSetting.schema.js";
import {
  createGoogleReviewHandler,
  deleteGoogleReviewHandler,
  getAllGoogleReviewsHandler,
  getGoogleReviewUploadUrlHandler,
  toggleGoogleReviewStatusHandler,
  updateGoogleReviewHandler,
} from "../controllers/googleReview.controller.js";
import {
  createGoogleReviewSchema,
  getGoogleReviewUploadUrlSchema,
  updateGoogleReviewSchema,
} from "../validators/googleReview.schema.js";
import {
  createComicFactHandler,
  deleteComicFactHandler,
  listComicFactsHandler,
  toggleComicFactStatusHandler,
  updateComicFactHandler,
} from "../controllers/comicFact.controller.js";
import {
  createComicFactSchema,
  updateComicFactSchema,
} from "../validators/comicFact.schema.js";
import {
  getContentHealthHandler,
  getStatsSummaryHandler,
  getStatsTimeseriesHandler,
} from "../controllers/stats.controller.js";
import {
  listAdminUsersHandler,
  updateUserRoleHandler,
} from "../controllers/user.controller.js";
import { updateUserRoleSchema } from "../validators/user.schema.js";
import {
  exportAdminCustomersHandler,
  listAdminCustomersHandler,
} from "../controllers/customer.controller.js";

const router = Router();

// Placeholder endpoint to verify the guard is working
router.get("/status", (req, res) => {
  res.json({
    success: true,
    message: "Admin router is active and guarded.",
    adminEmail: req.user?.email,
  });
});

// OVERVIEW DASHBOARD STATS
// Three endpoints, loaded independently by the overview page so the triage
// band paints without waiting on the chart. All literal paths — no param route
// lives under /stats, so there is no ordering hazard here.
router.get("/stats/summary", getStatsSummaryHandler); // KPIs + pipeline + triage + recent + top comics
router.get("/stats/timeseries", getStatsTimeseriesHandler); // chart series, IST buckets, zero-filled
router.get("/stats/content-health", getContentHealthHandler); // storefront config state, no range

// comic routes
router.get("/comics", getAdminComicsHandler); // get the comic rotues
router.get("/comics/:comicId", getAdminComicDetailHandler); // single comic full detail
// router.post("/comics/thumbnail/upload-url", getThumbnailUploadUrlHandler); // For uploading the thumbnail of the Comic
router.post("/comics/thumbnails/upload-urls", getThumbnailUploadUrlsBatchHandler);
router.post("/comics", validateBody(createComicSchema), createComicHandler); // create comic
router.delete("/comics/:comicId", deleteComicHandler); // delete comic
router.patch(
  "/comics/:comicId",
  validateBody(updateComicSchema),
  updateComicHandler
); // update comic
router.get("/comics/:comicId/pricing", getComicPricingHandler); // Get comic pricing
router.put(
  "/comics/:comicId/pricing",
  validateBody(updateComicPricingSchema),
  updateComicPricingHandler
); // update comic pricing
router.patch(
  "/comics/:comicId/status",
  validateBody(updateComicStatusSchema),
  updateComicStatusHandler
); // Publishing the status of comic

// PAGES
router.get("/comics/:comicId/pages", listComicPagesHandler); // list all pages for a comic with nested bubbles
router.post(
  "/comics/:comicId/pages",
  validateBody(createPageSchema),
  createPageHandler
); // create a new page
router.post(
  "/comics/:comicId/pages/upload-url",
  validateBody(getPageArtworkUploadUrlSchema),
  getPageArtworkUploadUrlHandler
); // presigned upload URL for artwork/mask
router.patch(
  "/pages/:pageId",
  validateBody(updatePageSchema),
  updatePageHandler
); // update page config
router.delete("/pages/:pageId", deletePageHandler); // delete page (cascades bubbles)

// Bubble-mapping preview. Renders the page's text stamping with a supplied name
// and pronoun so the admin can see the real output while mapping — same
// renderer the generation pipeline uses, no face swap, nothing persisted.
// Bubbles travel in the body because the mapper holds unsaved edits locally.
router.post(
  "/pages/:pageId/preview-stamp",
  validateBody(previewPageStampSchema),
  previewPageStampHandler
);

router.patch(
  "/comics/:comicId/pages/reorder",
  validateBody(reorderPagesSchema),
  reorderPagesHandler
); // reorder pages — send ALL page IDs in desired order

// BUBBLES
router.get("/pages/:pageId/bubbles", listPageBubblesHandler); // list all bubbles for a page with font info
router.post("/pages/:pageId/bubbles", validateBody(createBubbleSchema), createBubbleHandler); // create a bubble on a page
router.patch("/bubbles/:bubbleId", validateBody(updateBubbleSchema), updateBubbleHandler); // update bubble coordinates, dialogue, font
router.delete("/bubbles/:bubbleId", deleteBubbleHandler); // delete a single bubble


// FONTS
router.get("/comics/:comicId/fonts", listComicFontsHandler); // list all fonts for a comic with bubble usage count
router.post(
  "/comics/:comicId/fonts/upload-url",
  validateBody(getFontUploadUrlSchema),
  getFontUploadUrlHandler
); // presigned upload URL for font file
router.post(
  "/comics/:comicId/fonts",
  validateBody(createFontSchema),
  createFontHandler
); // create a font for a comic
router.patch(
  "/fonts/:fontId",
  validateBody(updateFontSchema),
  updateFontHandler
); // update font name or file
router.delete("/fonts/:fontId", deleteFontHandler); // delete font (blocks if bubbles reference it)
// Raw font bytes for the bubble-mapper canvas. Binary response, not the JSON
// envelope. Three segments, so no clash with PATCH/DELETE /fonts/:fontId.
router.get("/fonts/:fontId/file", getFontFileHandler);

// COMIC FACTS (rotating lines on the generation screens)
// Create/list hang off the comic; edit/toggle/delete use a flat /facts/:factId,
// matching how pages, bubbles and fonts are addressed in this file.
// Purely decorative — nothing here affects publishing or generation.
router.get("/comics/:comicId/facts", listComicFactsHandler); // ?placement= optional, includes inactive
router.post(
  "/comics/:comicId/facts",
  validateBody(createComicFactSchema),
  createComicFactHandler
);
router.patch(
  "/facts/:factId",
  validateBody(updateComicFactSchema),
  updateComicFactHandler
);
router.patch("/facts/:factId/status", toggleComicFactStatusHandler);
router.delete("/facts/:factId", deleteComicFactHandler);

// COMIC PREVIEW VIDEO
// Literal 2nd segment, so it can never be captured by /comics/:comicId/* —
// those all require a literal 3rd segment (pages, fonts, pricing, status).
// The saved key travels back through the unified PATCH /comics/:comicId as
// `videoKey`; there is deliberately no separate save endpoint.
router.post(
  "/comics/video/upload-url",
  validateBody(getComicVideoUploadUrlSchema),
  getComicVideoUploadUrlHandler
); // presigned upload URL for the optional carousel promo video

// LORA
router.post(
  "/comics/lora/upload-url",
  validateBody(getLoraUploadUrlSchema),
  getLoraUploadUrlHandler
); // presigned upload URL for LoRA file

// country routes
router.post("/countries/upload-url", getFlagUploadUrlHandler); // to upload the country flog image to the cloudflare
router.get("/countries", getAllCountriesHandler);
router.post("/countries", createCountryHandler); // to post the new country
router.put("/countries/:countryId", updateCountryHandler); // to update the existing country
router.delete("/countries/:countryId", deleteCountryHandler); // delete country (cascades its pricing rules away, no guard)

// theme routes :
router.post("/themes", validateBody(createThemeSchema), createThemeHandler); // create
router.patch(
  "/themes/:themeId",
  validateBody(updateThemeSchema),
  updateThemeHandler
); // update
router.delete("/themes/:themeId", deleteThemeHandler); // delete
// get route is in public folder

// announcement routes
router.post(
  "/announcements",
  validateBody(createAnnouncementSchema),
  createAnnouncementHandler
);
router.patch(
  "/announcements/reorder",
  validateBody(reorderAnnouncementsSchema),
  reorderAnnouncementsHandler
);
router.patch(
  "/announcements/:id",
  validateBody(updateAnnouncementSchema),
  updateAnnouncementHandler
);
router.get("/announcements", listAnnouncementsHandler);
router.patch("/announcements/:id/status", toggleAnnouncementStatusHandler);
router.delete("/announcements/:id", deleteAnnouncementHandler);

// hero images routes
router.post(
  "/hero-images/upload-url",
  validateBody(getHeroImageUploadUrlSchema),
  getHeroImageUploadUrlHandler
);
router.post(
  "/hero-images",
  validateBody(createHeroImageSchema),
  createHeroImageHandler
);
router.patch("/hero-images/:id/status", toggleHeroImageStatusHandler);
router.get("/hero-images", getAllHeroImagesHandler);
router.delete("/hero-images/:id", deleteHeroImageHandler);

// customer Reviews
router.post(
  "/customer-reviews/upload-url",
  validateBody(getCustomerReviewUploadUrlSchema),
  getCustomerReviewUploadUrlHandler
);
router.post(
  "/customer-reviews",
  validateBody(createCustomerReviewSchema),
  createCustomerReviewHandler
);
router.patch("/customer-reviews/:id/status", toggleCustomerReviewStatusHandler);
router.delete("/customer-reviews/:id", deleteCustomerReviewHandler);
router.get("/customer-reviews", getAllCustomerReviewsHandler);

// google reviews — homepage "Excellent On Google" section
// /upload-url stays ABOVE /:id: both are POST-adjacent param routes and
// Express matches whichever is registered first.
router.post(
  "/google-reviews/upload-url",
  validateBody(getGoogleReviewUploadUrlSchema),
  getGoogleReviewUploadUrlHandler
);
router.get("/google-reviews", getAllGoogleReviewsHandler);
router.post(
  "/google-reviews",
  validateBody(createGoogleReviewSchema),
  createGoogleReviewHandler
);
router.patch(
  "/google-reviews/:id",
  validateBody(updateGoogleReviewSchema),
  updateGoogleReviewHandler
);
router.patch("/google-reviews/:id/status", toggleGoogleReviewStatusHandler);
router.delete("/google-reviews/:id", deleteGoogleReviewHandler);

// team member's
router.post(
  "/team-members/upload-url",
  validateBody(getTeamMemberUploadUrlSchema),
  getTeamMemberUploadUrlHandler
);
router.post(
  "/team-members",
  validateBody(createTeamMemberSchema),
  createTeamMemberHandler
);
router.patch(
  "/team-members/:id",
  validateBody(updateTeamMemberSchema),
  updateTeamMemberHandler
);
router.patch("/team-members/:id/status", toggleTeamMemberStatusHandler);
router.delete("/team-members/:id", deleteTeamMemberHandler);
router.get("/team-members", getAllTeamMembersHandler);
// router.get("/team-members/active", getActiveTeamMembersHandler);

// how it works
router.get("/how-it-works", getAdminHowItWorksHandler);
router.post(
  "/how-it-works/upload-url",
  validateBody(getHowItWorksUploadUrlSchema),
  getHowItWorksUploadUrlHandler
);
router.patch(
  "/how-it-works",
  validateBody(updateHowItWorksSchema),
  updateHowItWorksHandler
);

// faqs
// NOTE: /faqs/reorder MUST stay above /faqs/:id — both are PATCH with the
// same segment count, so Express matches whichever is registered first.
router.get("/faqs", getAllFaqsHandler);
router.post("/faqs", validateBody(createFaqSchema), createFaqHandler);
router.patch(
  "/faqs/reorder",
  validateBody(reorderFaqsSchema),
  reorderFaqsHandler
);
router.patch("/faqs/:id", validateBody(updateFaqSchema), updateFaqHandler);
router.patch("/faqs/:id/status", toggleFaqStatusHandler);
router.delete("/faqs/:id", deleteFaqHandler);

// blogs
// /blogs/upload-url is a POST and /blogs/:id is GET/PATCH/DELETE, so there is
// no same-method collision here — but keep the literal path above the param
// one anyway, matching the rest of this file.
router.post(
  "/blogs/upload-url",
  validateBody(getBlogUploadUrlSchema),
  getBlogUploadUrlHandler
);
router.get("/blogs", getAdminBlogsHandler);
router.get("/blogs/:id", getAdminBlogByIdHandler);
router.post("/blogs", validateBody(createBlogSchema), createBlogHandler);
router.patch("/blogs/:id", validateBody(updateBlogSchema), updateBlogHandler);
router.patch("/blogs/:id/status", toggleBlogStatusHandler);
router.delete("/blogs/:id", deleteBlogHandler);


// ORDERS (Section 7 — Shiprocket admin)
// Route ordering note: literal paths (/orders/failed) will be registered
// ABOVE /orders/:orderId when we get to endpoint 8. Follow that rule.
router.get("/orders", listAdminOrdersHandler);
router.get("/orders/:orderId", getAdminOrderDetailHandler);
router.get("/orders/:orderId/label", getOrderLabelHandler);
router.post(
  "/orders/:orderId/confirm-dimensions",
  validateBody(confirmDimensionsBodySchema),
  confirmDimensionsHandler
);
router.post("/orders/:orderId/retry-shiprocket", retryShiprocketHandler);
router.post("/orders/:orderId/refresh-tracking", refreshTrackingHandler);

// USERS (admin user management)
// List every account; promote/demote. No ordering hazard: the PATCH has a
// literal 3rd segment (/role) and there is no other /users/:userId route.
router.get("/users", listAdminUsersHandler);
router.patch(
  "/users/:userId/role",
  validateBody(updateUserRoleSchema),
  updateUserRoleHandler
);

// CUSTOMERS (accounts with at least one paid order)
// Read-only. Both paths are literal — no /customers/:id route exists — so
// there is no ordering hazard. /export returns a CSV file, not JSON.
router.get("/customers", listAdminCustomersHandler);
router.get("/customers/export", exportAdminCustomersHandler);

// SITE PAGES (privacy / terms / refund)
// No create or delete: the slug set is fixed by the SitePageSlug enum, so the
// PUT upserts and that is the only way a row ever comes into existence.
// isActive is owned solely by the /status route — saving never publishes.
router.get("/site-pages", getAdminSitePagesHandler);
router.get("/site-pages/:slug", getAdminSitePageHandler);
router.put(
  "/site-pages/:slug",
  validateBody(upsertSitePageSchema),
  upsertSitePageHandler
);
router.patch("/site-pages/:slug/status", toggleSitePageStatusHandler);

// SITE SETTINGS (brand + contact details — singleton)
// PATCH, not PUT: every field is optional and partial updates are the normal
// case, matching /how-it-works.
router.get("/site-settings", getAdminSiteSettingHandler);
router.patch(
  "/site-settings",
  validateBody(updateSiteSettingSchema),
  updateSiteSettingHandler
);

// feedback — anonymous book suggestions. Contact enquiries are a separate
// domain with its own table and routes; see below.
router.get("/feedbacks", getAllFeedbacksHandler);
router.patch(
  "/feedbacks/:id/status",
  validateBody(updateFeedbackStatusSchema),
  updateFeedbackStatusHandler
);
router.delete("/feedbacks/:id", deleteFeedbackHandler);


// contact enquiries — /contact form submissions. No create route: those come in
// through the public router. No ordering hazard with /:id, the segment counts differ.
router.get("/contact-enquiries", getAllContactEnquiriesHandler);
router.patch(
  "/contact-enquiries/:id/status",
  validateBody(updateContactEnquiryStatusSchema),
  updateContactEnquiryStatusHandler
);
router.delete("/contact-enquiries/:id", deleteContactEnquiryHandler);


export default router;
