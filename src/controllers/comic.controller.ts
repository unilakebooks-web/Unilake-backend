import type { Request, Response } from "express";
import { z, ZodError, type ZodIssue } from "zod";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ValidationError } from "../utils/errors.js";
import { sendSuccess } from "../utils/response.js";
import { logger } from "../lib/logger.js";
import {
  createComic,
  generateThumbnailUploadUrlsBatch,
  updateComicPricing,
  getComicPricing,
  updateComicStatus,
  getPublicComicsList,
  getPublicComicDetails,
  updateComic,
  getLoraUploadUrl,
  deleteComic,
  getAdminComicsList,
  getAdminComicDetail,
  generateComicVideoUploadUrl
} from "../services/comic.service.js";
import {
  adminComicFilterQuerySchema,
  comicFilterQuerySchema,
  getLoraUploadUrlSchema,
  uploadThumbnailsBatchSchema,
} from "../validators/comic.schema.js";

const uploadThumbnailRequestSchema = z.object({
  fileName: z.string().min(1, "File name is required"),
  contentType: z
    .string()
    .regex(
      /^image\/(png|jpeg|jpg|webp)$/,
      "Invalid content type. Only PNG, JPEG, and WEBP images are allowed for thumbnails."
    ),
});

// export const getThumbnailUploadUrlHandler = asyncHandler(
//   async (req: Request, res: Response) => {
//     try {
//       logger.debug(
//         { body: req.body },
//         "Incoming request for comic thumbnail upload URL"
//       );

//       const { fileName, contentType } = uploadThumbnailRequestSchema.parse(
//         req.body
//       );

//       const { uploadUrl, key } = await generateThumbnailUploadUrl(
//         fileName,
//         contentType
//       );

//       sendSuccess(
//         res,
//         200,
//         { uploadUrl, key },
//         "Presigned thumbnail upload URL generated successfully"
//       );
//     } catch (error: any) {
//       if (error instanceof ZodError) {
//         const errorMessages = error.issues
//           .map((issue: ZodIssue) => issue.message)
//           .join(", ");
//         throw new ValidationError(errorMessages);
//       }
//       throw error;
//     }
//   }
// );

export const getThumbnailUploadUrlsBatchHandler = asyncHandler(
  async (req: Request, res: Response) => {
    try {
      logger.debug(
        { body: req.body },
        "Incoming request for batch thumbnail upload URLs"
      );

      const { files } = uploadThumbnailsBatchSchema.parse(req.body);

      const result = await generateThumbnailUploadUrlsBatch(files);

      sendSuccess(
        res,
        200,
        result,
        "Presigned thumbnail upload URLs generated successfully"
      );
    } catch (error: any) {
      if (error instanceof ZodError) {
        const errorMessages = error.issues
          .map((issue: ZodIssue) => issue.message)
          .join(", ");
        throw new ValidationError(errorMessages);
      }
      throw error;
    }
  }
);

export const createComicHandler = asyncHandler(
  async (req: Request, res: Response) => {
    logger.debug(
      { body: req.body },
      "Incoming request to create comic (Validation Passed)"
    );

    const newComic = await createComic(req.body);

    sendSuccess(res, 201, newComic, "Comic catalogue item created successfully.");
  }
);

export const updateComicHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const { comicId } = req.params;

    if (!comicId || typeof comicId !== "string") {
      throw new ValidationError("comicId param is required");
    }

    const updatedComic = await updateComic(comicId, req.body);

    sendSuccess(res, 200, updatedComic);
  }
);

export const deleteComicHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const { comicId } = req.params;

    if (!comicId || typeof comicId !== "string") {
      throw new ValidationError("Comic ID is required.");
    }

    await deleteComic(comicId);
    res.status(204).send();
  }
);

export const updateComicPricingHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const { comicId } = req.params;

    if (!comicId || typeof comicId !== "string") {
      throw new ValidationError("Comic ID is required in the URL parameters.");
    }

    logger.debug(
      { comicId, body: req.body },
      "Incoming request to replace pricing rules"
    );

    const updatedComic = await updateComicPricing(comicId, req.body);

    sendSuccess(res, 200, updatedComic, "Pricing rules fully replaced.");
  }
);

export const getComicPricingHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const { comicId } = req.params;

    if (!comicId || typeof comicId !== "string") {
      throw new ValidationError(
        "Comic ID is required and must be a single valid string."
      );
    }

    logger.debug({ comicId }, "Incoming request to fetch comic pricing rules");

    const pricingData = await getComicPricing(comicId);

    sendSuccess(res, 200, pricingData, "Pricing rules fetched successfully.");
  }
);

export const updateComicStatusHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const { comicId } = req.params;

    if (!comicId || typeof comicId !== "string") {
      throw new ValidationError(
        "Comic ID is required and must be a single valid string."
      );
    }

    logger.debug(
      { comicId, body: req.body },
      "Incoming request to update comic status"
    );

    // req.body is validated by the router middleware
    const updatedComic = await updateComicStatus(comicId, req.body);

    sendSuccess(
      res,
      200,
      updatedComic,
      `Comic status successfully changed to ${updatedComic.status}.`
    );
  }
);

export const getPublicComicsHandler = asyncHandler(
  async (req: Request, res: Response) => {
    try {
      const validatedQuery = comicFilterQuerySchema.parse(req.query);

      const comics = await getPublicComicsList(validatedQuery);

      sendSuccess(res, 200, comics);
    } catch (error: any) {
      if (error instanceof ZodError) {
        const errorMessages = error.issues
          .map((issue) => issue.message)
          .join(", ");
        throw new ValidationError(`Query error: ${errorMessages}`);
      }
      throw error;
    }
  }
);


export const getPublicComicDetailsHandler = asyncHandler(async (req: Request, res: Response) => {
  const { comicId } = req.params;

  if (!comicId || typeof comicId !== "string") {
    throw new ValidationError("Comic ID is required.");
  }

  const comic = await getPublicComicDetails(comicId);

  sendSuccess(res, 200, comic);
});

//
export const getLoraUploadUrlHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const result = await getLoraUploadUrl(req.body);
    sendSuccess(res, 200, result);
  }
);

// req.body is validated by getComicVideoUploadUrlSchema on the route.
export const getComicVideoUploadUrlHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const { fileName, contentType } = req.body;

    logger.debug(
      { fileName, contentType },
      "Incoming request for comic preview video upload URL"
    );

    const result = await generateComicVideoUploadUrl(fileName, contentType);

    sendSuccess(
      res,
      200,
      result,
      "Presigned video upload URL generated successfully"
    );
  }
);


export const getAdminComicsHandler = asyncHandler(
  async (req: Request, res: Response) => {
    try {
      const validatedQuery = adminComicFilterQuerySchema.parse(req.query);
      const comics = await getAdminComicsList(validatedQuery);

      sendSuccess(res, 200, comics);
    } catch (error: any) {
      if (error instanceof ZodError) {
        const errorMessages = error.issues
          .map((issue: ZodIssue) => issue.message)
          .join(", ");
        throw new ValidationError(`Query error: ${errorMessages}`);
      }
      throw error;
    }
  }
);

export const getAdminComicDetailHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const { comicId } = req.params;

    if (!comicId || typeof comicId !== "string") {
      throw new ValidationError("Comic ID is required.");
    }

    const comic = await getAdminComicDetail(comicId);

    sendSuccess(res, 200, comic);
  }
);