import type { Request, Response } from "express";
import { ZodError } from "zod";
import { asyncHandler } from "../utils/asyncHandler.js";
import { sendSuccess } from "../utils/response.js";
import { ValidationError } from "../utils/errors.js";
import { adminBlogQuerySchema } from "../validators/blog.schema.js";
import {
  createBlog,
  deleteBlog,
  getBlogByIdAdmin,
  getBlogBySlugPublic,
  getBlogUploadUrl,
  listBlogsAdmin,
  listBlogsPublic,
  toggleBlogStatus,
  updateBlog,
} from "../services/blog.service.js";

// Local copy rather than importing faq.controller's — the two controllers stay
// independent if their query-parsing needs ever diverge. There is no
// validateQuery middleware; this is the established stand-in.
function parseQueryOrThrow<T>(
  schema: { parse: (data: unknown) => T },
  query: unknown
): T {
  try {
    return schema.parse(query);
  } catch (error) {
    if (error instanceof ZodError) {
      const errorMessages = error.issues.map((issue) => issue.message).join(", ");
      throw new ValidationError(`Query error: ${errorMessages}`);
    }
    throw error;
  }
}

export const getBlogUploadUrlHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const result = await getBlogUploadUrl(req.body);
    sendSuccess(res, 200, result);
  }
);

export const createBlogHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const blog = await createBlog(req.body);
    sendSuccess(res, 201, blog);
  }
);

export const updateBlogHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const blog = await updateBlog(id as string, req.body);
    sendSuccess(res, 200, blog);
  }
);

export const getAdminBlogsHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const query = parseQueryOrThrow(adminBlogQuerySchema, req.query);
    const blogs = await listBlogsAdmin(query.isActive);
    sendSuccess(res, 200, blogs);
  }
);

export const getAdminBlogByIdHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const blog = await getBlogByIdAdmin(id as string);
    sendSuccess(res, 200, blog);
  }
);

export const getPublicBlogsHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const blogs = await listBlogsPublic();
    sendSuccess(res, 200, blogs);
  }
);

export const getPublicBlogBySlugHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const { slug } = req.params;
    const blog = await getBlogBySlugPublic(slug as string);
    sendSuccess(res, 200, blog);
  }
);

export const toggleBlogStatusHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const blog = await toggleBlogStatus(id as string);
    sendSuccess(res, 200, blog);
  }
);

export const deleteBlogHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params;
    await deleteBlog(id as string);
    res.status(204).send();
  }
);
