import type { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler.js";
import { sendSuccess } from "../utils/response.js";
import {
  createContactEnquiry,
  deleteContactEnquiry,
  getAllContactEnquiries,
  updateContactEnquiryStatus,
} from "../services/contactEnquiry.service.js";
import { contactEnquiryFilterQuerySchema } from "../validators/contactEnquiry.schema.js";
import { ZodError } from "zod";
import { ValidationError } from "../utils/errors.js";

export const createContactEnquiryHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const enquiry = await createContactEnquiry(req.body);
    sendSuccess(res, 201, enquiry);
  }
);

export const getAllContactEnquiriesHandler = asyncHandler(
  async (req: Request, res: Response) => {
    try {
      const validatedQuery = contactEnquiryFilterQuerySchema.parse(req.query);
      const enquiries = await getAllContactEnquiries(validatedQuery.status);
      sendSuccess(res, 200, enquiries);
    } catch (error: any) {
      if (error instanceof ZodError) {
        const errorMessages = error.issues
          .map((issue: { message: string }) => issue.message)
          .join(", ");
        throw new ValidationError(`Query error: ${errorMessages}`);
      }
      throw error;
    }
  }
);

export const updateContactEnquiryStatusHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const enquiry = await updateContactEnquiryStatus(
      id as string,
      req.body.status
    );
    sendSuccess(res, 200, enquiry);
  }
);

export const deleteContactEnquiryHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params;
    await deleteContactEnquiry(id as string);
    res.status(204).send();
  }
);
