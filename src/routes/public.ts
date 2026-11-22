import { Router } from "express";
import { 
  getPublicComicsHandler, 
  getPublicComicDetailsHandler 
} from "../controllers/comic.controller.js";
import { validateBody } from "../middlewares/validateBody.js";
import { requireLoggedIn } from "../middlewares/requireLoggedIn.js";
import { createSessionSchema, photoUploadUrlSchema, photoConfirmSchema, updateSessionSchema   } from "../validators/session.schema.js";
import { createPhotoUploadUrlHandler, createSessionHandler,getSessionHandler, updateSessionHandler, confirmSessionPhotoHandler, generateSessionHandler, regeneratePageHandler, attachUserHandler } from "../controllers/session.controller.js";
import { initiateCheckoutHandler } from "../controllers/checkout.controller.js";
import { confirmPaymentHandler } from "../controllers/paymentConfirmation.controller.js";
import { previewCouponHandler, listCouponOffersHandler } from "../controllers/couponCheckout.controller.js";
import { getAllThemesHandler } from "../controllers/theme.controller.js";
import { getActiveHeroImagesHandler } from "../controllers/heroImage.controller.js";
import { getActiveCustomerReviewsHandler } from "../controllers/customerReview.controller.js";
import { getActiveAnnouncementsHandler } from "../controllers/announcement.controller.js";
import { createFeedbackHandler } from "../controllers/feedback.controller.js";
import { createFeedbackSchema } from "../validators/feedback.schema.js";
import { createContactEnquiryHandler } from "../controllers/contactEnquiry.controller.js";
import { createContactEnquirySchema } from "../validators/contactEnquiry.schema.js";
import { getActiveTeamMembersHandler } from "../controllers/teamMember.controller.js";
import { getActiveCountriesHandler } from "../controllers/country.controller.js";
import { getPublicHowItWorksHandler } from "../controllers/howItWorks.controller.js";
import { getActiveFaqsHandler } from "../controllers/faq.controller.js";
import {
  getPublicBlogBySlugHandler,
  getPublicBlogsHandler,
} from "../controllers/blog.controller.js";
import { getPublicSitePageHandler } from "../controllers/sitePage.controller.js";
import { getActiveGoogleReviewsHandler } from "../controllers/googleReview.controller.js";
import { getPublicSiteSettingHandler } from "../controllers/siteSetting.controller.js";
import {
  createShareHandler,
  getShareStateHandler,
  getSharedBookHandler,
  getSharedCardHandler,
  getSharedImageHandler,
  revokeShareHandler,
  updateShareHandler,
} from "../controllers/share.controller.js";
import { createShareSchema, updateShareSchema } from "../validators/share.schema.js";
import {
  applyUnsubscribeHandler,
  getUnsubscribeInfoHandler,
} from "../controllers/emailPreferences.controller.js";
const router = Router();

// This will give the public comic
router.get("/comics", getPublicComicsHandler);
router.get("/comics/:comicId", getPublicComicDetailsHandler);// this will give details of a single comic


router.post( "/sessions", validateBody(createSessionSchema), createSessionHandler);// this will initiate the session with just comic ID
router.patch('/sessions/:sessionId', validateBody(updateSessionSchema), updateSessionHandler);// this will add the child details to the 
router.get("/sessions/:sessionId", getSessionHandler);// This will give the live session for the user to comeback and look at the comic 
router.post('/sessions/:sessionId/photo/upload-url', validateBody(photoUploadUrlSchema), createPhotoUploadUrlHandler );// this will give the upload URL to add child's picture
router.post( '/sessions/:sessionId/photo/confirm', validateBody(photoConfirmSchema), confirmSessionPhotoHandler );// This will save the finalized photo sent by the frotend
router.post("/sessions/:sessionId/generate", generateSessionHandler);// This will generate the session 
router.patch("/sessions/:sessionId/attach-user", requireLoggedIn, attachUserHandler);// Attach logged-in user to anonymous session
router.post("/sessions/:sessionId/pages/:pageNumber/regenerate", regeneratePageHandler);// This endpoint will let the user generate a single photo
router.post("/sessions/:sessionId/checkout", initiateCheckoutHandler); // creates Razorpay order + Order row
router.post("/sessions/:sessionId/confirm-payment", confirmPaymentHandler); // asks Razorpay whether the payment was received, marks the order paid
router.post("/sessions/:sessionId/coupon-preview", requireLoggedIn, previewCouponHandler); // read-only: what would this coupon code take off
router.get("/sessions/:sessionId/coupon-offers", requireLoggedIn, listCouponOffersHandler); // read-only: the coupons that fit this order right now
router.get("/sessions/:sessionId/share", getShareStateHandler); // the Share button: is sharing possible, and is a link live
router.post("/sessions/:sessionId/share", validateBody(createShareSchema), createShareHandler); // create or return the view-only link
router.patch("/sessions/:sessionId/share", validateBody(updateShareSchema), updateShareHandler); // change only the name flag of a live link
router.delete("/sessions/:sessionId/share", revokeShareHandler); // stop sharing

// the view-only shared book: the share token is the only credential, and it is never the session id
router.get("/shares/:token", getSharedBookHandler);
router.get("/shares/:token/pages/:pageNumber/image", getSharedImageHandler);
router.get("/shares/:token/pages/:pageNumber/card.jpg", getSharedCardHandler);



// theme endpoint : 

router.get("/themes", getAllThemesHandler);

// announcement : 
router.get("/announcements", getActiveAnnouncementsHandler);

// hero-image
router.get("/hero-images", getActiveHeroImagesHandler);


// customer reviews get endpoint :
router.get("/customer-reviews", getActiveCustomerReviewsHandler);


// google reviews — active only, newest first
router.get("/google-reviews", getActiveGoogleReviewsHandler);


// team meber
router.get("/team-members", getActiveTeamMembersHandler);


// how it works — homepage explainer
router.get("/how-it-works", getPublicHowItWorksHandler);


// faqs — ?placement=HOME|COMIC (required)
router.get("/faqs", getActiveFaqsHandler);


// blogs — published only; detail is looked up by slug, not id
router.get("/blogs", getPublicBlogsHandler);
router.get("/blogs/:slug", getPublicBlogBySlugHandler);


// countries — active only, for the shipping/pricing country picker
router.get("/countries", getActiveCountriesHandler);



// site pages — published only; 404 for an unpublished or never-saved page
router.get("/site-pages/:slug", getPublicSitePageHandler);


// site settings — brand + contact details. Consumed by /contact AND the
// Footer, so this is hit on every page load; returns null until first saved.
router.get("/site-settings", getPublicSiteSettingHandler);


// feedback — anonymous book suggestions from the homepage block. No contact
// details by design; see contact-enquiries below for the /contact form.
router.post("/feedbacks", validateBody(createFeedbackSchema), createFeedbackHandler);


// contact enquiries — the /contact form. Separate endpoint and separate table
// from feedback: this one carries a reply channel and is expected to be answered.
router.post(
  "/contact-enquiries",
  validateBody(createContactEnquirySchema),
  createContactEnquiryHandler
);

// email unsubscribe — the link in a bulk email. GET only describes (so a mail scanner cannot unsubscribe
// anyone); POST does it, and is also the one-click POST named in the List-Unsubscribe header.
router.get("/email/unsubscribe/:token", getUnsubscribeInfoHandler);
router.post("/email/unsubscribe/:token", applyUnsubscribeHandler);

export default router;