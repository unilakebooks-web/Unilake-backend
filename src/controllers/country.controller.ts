import type { Request, Response } from "express";
import { success, z, ZodError, type ZodIssue } from "zod";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ValidationError } from "../utils/errors.js";
import { sendSuccess } from "../utils/response.js";
import { logger } from "../lib/logger.js";
import {
  generateFlagUploadUrl,
  createCountry,
  updateCountry,
  getAllCountries,
  getActiveCountries,
  deleteCountry
} from "../services/country.service.js";
import {
  createCountrySchema,
  updateCountrySchema,
} from "../validators/country.schema.js";

const uploadUrlRequestSchema = z.object({
  fileName: z.string().min(1, "file name is requried"),

  contentType: z
    .string()
    .regex(
      /^image\/(png|jpeg|jpg|svg\+xml|webp)$/,
      "Invalid content type. Only PNG, JPEG, SVG, and WEBP images are allowed."
    ),
});

export const getFlagUploadUrlHandler = asyncHandler(
  async (req: Request, res: Response) => {
    try {
      logger.debug({ body: req.body }, "Incoming Request for floag upload URL");

      // validate the nncoming request
      const { fileName, contentType } = uploadUrlRequestSchema.parse(req.body);

      const { uploadUrl, key } = await generateFlagUploadUrl(
        fileName,
        contentType
      );

      sendSuccess(
        res,
        200,
        { uploadUrl, key },
        "Presigned upload URL generated successfully"
      );
    } catch (error: any) {
      if (error instanceof ZodError) {
        const errorMessages = error.issues
          .map((issue: ZodIssue) => issue.message)
          .join(",");

        throw new ValidationError(errorMessages);
      }
      throw error;
    }
  }
);

export const createCountryHandler = asyncHandler(
  async (req: Request, res: Response) => {
    try {
      logger.debug({ body: req.body }, "Incoming request to create country");

      const validatedData = createCountrySchema.parse(req.body);

      const newCountry = await createCountry(validatedData);

      sendSuccess(res, 201, newCountry, "Country record created successfully.");
    } catch (error) {
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

export const updateCountryHandler = asyncHandler(
  async (req: Request, res: Response) => {
    try {
      const { countryId } = req.params;
      logger.debug(
        { countryId, body: req.body },
        "Incoming request to update country"
      );

      if (!countryId) {
        throw new ValidationError(
          "Country ID is required in the URL parameters."
        );
      }

      const validatedData = updateCountrySchema.parse(req.body);

      if (Object.keys(validatedData).length === 0) {
        throw new ValidationError("No valid fields provided for update.");
      }

      const updatedCountry = await updateCountry(countryId, validatedData);

      sendSuccess(res, 200, updatedCountry, "Country record updated successfully.");

    }catch (error) {
    if (error instanceof ZodError) {
      const errorMessages = error.issues
        .map((issue: ZodIssue) => issue.message)
        .join(", ");
      throw new ValidationError(errorMessages);
    }
    throw error;
  }
});

export const getAllCountriesHandler = asyncHandler(async (req: Request, res : Response)=> {
    logger.debug("Incoming request to fetch all countries");

    const countries = await getAllCountries();

    sendSuccess(res, 200, countries);
})

// Public catalogue of shipping/pricing countries. Admins use
// getAllCountriesHandler, which also returns deactivated rows.
export const getActiveCountriesHandler = asyncHandler(
  async (req: Request, res: Response) => {
    logger.debug("Incoming request to fetch active countries");

    const countries = await getActiveCountries();

    sendSuccess(res, 200, countries);
  }
);


export const deleteCountryHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const { countryId } = req.params;

    if (!countryId || typeof countryId !== "string") {
      throw new ValidationError("Country ID is required.");
    }

    const result = await deleteCountry(countryId);

    // 200 with the envelope, not a bare 204: the caller needs the cascade count
    // to tell the admin what was actually destroyed, and this was the one
    // country endpoint sitting outside the sendSuccess contract.
    sendSuccess(res, 200, result, "Country deleted successfully.");
  }
);
