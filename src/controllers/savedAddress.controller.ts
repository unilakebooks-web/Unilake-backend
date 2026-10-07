import type { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ValidationError } from "../utils/errors.js";
import { sendSuccess } from "../utils/response.js";
import {
  listUserAddresses,
  createAddress,
  updateAddress,
  deleteAddress,
  setDefaultAddress,
} from "../services/savedAddress.service.js";

export const listAddressesHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user!.id;

    const addresses = await listUserAddresses(userId);

    sendSuccess(res, 200, addresses);
  }
);

export const createAddressHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user!.id;

    const address = await createAddress(userId, req.body);

    sendSuccess(res, 201, address, "Address saved successfully");
  }
);

export const updateAddressHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params;
    if (!id || typeof id !== "string") {
      throw new ValidationError("Address ID is required");
    }

    const userId = req.user!.id;

    const address = await updateAddress(id, userId, req.body);

    sendSuccess(res, 200, address);
  }
);

export const deleteAddressHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params;
    if (!id || typeof id !== "string") {
      throw new ValidationError("Address ID is required");
    }

    const userId = req.user!.id;

    await deleteAddress(id, userId);

    sendSuccess(res, 200, null, "Address deleted");
  }
);

export const setDefaultAddressHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params;
    if (!id || typeof id !== "string") {
      throw new ValidationError("Address ID is required");
    }

    const userId = req.user!.id;

    const address = await setDefaultAddress(id, userId);

    sendSuccess(res, 200, address, "Default address updated");
  }
);