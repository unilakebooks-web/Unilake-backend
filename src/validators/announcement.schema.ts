import { z } from 'zod';

export const createAnnouncementSchema = z.object({
    message: z.string().trim().min(1, 'message is required')
})

export const updateAnnouncementSchema = z
    .object({
        message: z.string().trim().min(1, 'message cannot be empty').optional(),
    })
    .refine((data) => Object.keys(data).length > 0, {
        message: 'At least one field must be provided',
    });

export const reorderAnnouncementsSchema = z.object({
    orderedIds: z
        .array(z.string().uuid())
        .min(1, 'orderedIds cannot be empty')
        .refine((ids) => new Set(ids).size === ids.length, {
            message: 'orderedIds cannot contain duplicates',
        }),
});
