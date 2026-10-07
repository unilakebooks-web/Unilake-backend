import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { NotFoundError } from "../utils/errors.js";
import type { ContactEnquiryStatus } from "../generated/prisma/client.js";

// Contact enquiries are deliberately a separate domain from Feedback. Feedback
// is an anonymous suggestion about the books with no reply channel by design;
// an enquiry is a person asking a question and expecting an answer. Same
// shape, opposite intent — one inbox for both makes neither triagable.

export async function createContactEnquiry(data: {
  name: string;
  email: string;
  phone: string;
  message: string;
}) {
  const enquiry = await prisma.contactEnquiry.create({
    data: {
      name: data.name,
      email: data.email,
      phone: data.phone,
      message: data.message,
    },
  });

  // Email and phone are deliberately NOT logged — this is the one place in the
  // codebase that collects a visitor's contact details, and pino writes to a
  // shared log sink.
  logger.info({ contactEnquiryId: enquiry.id }, "Contact enquiry submitted");

  return enquiry;
}

export async function getAllContactEnquiries(status?: ContactEnquiryStatus) {
  const enquiries = await prisma.contactEnquiry.findMany({
    where: {
      ...(status !== undefined && { status }),
    },
    orderBy: { createdAt: "desc" },
  });

  return enquiries;
}

export async function updateContactEnquiryStatus(
  id: string,
  status: ContactEnquiryStatus
) {
  const existing = await prisma.contactEnquiry.findUnique({ where: { id } });

  if (!existing) {
    throw new NotFoundError("Contact enquiry not found");
  }

  const updated = await prisma.contactEnquiry.update({
    where: { id },
    data: { status },
  });

  logger.info(
    { contactEnquiryId: id, status: updated.status },
    "Contact enquiry status updated"
  );

  return updated;
}

export async function deleteContactEnquiry(id: string) {
  const existing = await prisma.contactEnquiry.findUnique({ where: { id } });

  if (!existing) {
    throw new NotFoundError("Contact enquiry not found");
  }

  await prisma.contactEnquiry.delete({ where: { id } });

  logger.info({ contactEnquiryId: id }, "Contact enquiry deleted");
}
