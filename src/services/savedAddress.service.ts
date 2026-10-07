import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { NotFoundError, ForbiddenError } from "../utils/errors.js";
import type { CreateAddressInput, UpdateAddressInput } from "../validators/savedAddress.schema.js";
import type { Prisma } from "../generated/prisma/client.js";

async function findAddressWithOwnershipCheck(addressId: string, userId: string) {
  const address = await prisma.savedAddress.findUnique({
    where: { id: addressId },
  });

  if (!address) {
    throw new NotFoundError("Address not found");
  }

  if (address.userId !== userId) {
    throw new ForbiddenError("You do not have permission to access this address");
  }

  return address;
}

export async function listUserAddresses(userId: string) {
  const addresses = await prisma.savedAddress.findMany({
    where: { userId },
    orderBy: [
      { isDefault: "desc" },
      { createdAt: "desc" },
    ],
  });

  return addresses;
}

export async function createAddress(userId: string, input: CreateAddressInput) {
  const existingCount = await prisma.savedAddress.count({
    where: { userId },
  });

  const address = await prisma.savedAddress.create({
    data: {
      userId,
      label: input.label,
      name: input.name,
      line1: input.line1,
      line2: input.line2,
      city: input.city,
      state: input.state,
      zip: input.zip,
      country: input.country,
      phone: input.phone,
      isDefault: existingCount === 0,
    },
  });

  logger.info(
    { addressId: address.id, userId, isDefault: address.isDefault },
    "Saved address created"
  );

  return address;
}

export async function updateAddress(addressId: string, userId: string, input: UpdateAddressInput) {
  await findAddressWithOwnershipCheck(addressId, userId);

  const data: Prisma.SavedAddressUpdateInput = {};
  if (input.label !== undefined) data.label = input.label;
  if (input.name !== undefined) data.name = input.name;
  if (input.line1 !== undefined) data.line1 = input.line1;
  if (input.line2 !== undefined) data.line2 = input.line2;
  if (input.city !== undefined) data.city = input.city;
  if (input.state !== undefined) data.state = input.state;
  if (input.zip !== undefined) data.zip = input.zip;
  if (input.country !== undefined) data.country = input.country;
  if (input.phone !== undefined) data.phone = input.phone;

  const updated = await prisma.savedAddress.update({
    where: { id: addressId },
    data,
  });

  logger.info(
    { addressId, userId, fields: Object.keys(data) },
    "Saved address updated"
  );

  return updated;
}

export async function deleteAddress(addressId: string, userId: string) {
  const address = await findAddressWithOwnershipCheck(addressId, userId);

  await prisma.savedAddress.delete({
    where: { id: addressId },
  });

  if (address.isDefault) {
    const nextAddress = await prisma.savedAddress.findFirst({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });

    if (nextAddress) {
      await prisma.savedAddress.update({
        where: { id: nextAddress.id },
        data: { isDefault: true },
      });

      logger.info(
        { promotedAddressId: nextAddress.id, userId },
        "Promoted next address to default after default was deleted"
      );
    }
  }

  logger.info({ addressId, userId }, "Saved address deleted");
}

export async function setDefaultAddress(addressId: string, userId: string) {
  await findAddressWithOwnershipCheck(addressId, userId);

  await prisma.$transaction([
    prisma.savedAddress.updateMany({
      where: { userId },
      data: { isDefault: false },
    }),
    prisma.savedAddress.update({
      where: { id: addressId },
      data: { isDefault: true },
    }),
  ]);

  const updated = await prisma.savedAddress.findUnique({
    where: { id: addressId },
  });

  logger.info({ addressId, userId }, "Default address changed");

  return updated;
}