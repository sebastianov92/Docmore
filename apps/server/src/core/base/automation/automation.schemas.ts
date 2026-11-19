import { z } from 'zod';
import { basePropertyIdSchema } from '../base-ids';
import { filterGroupSchema } from '../engine/schema.zod';

// When: a row appears, a row (or one property) changes, a form submits,
// or someone presses a button.
export const triggerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('row.created') }),
  z.object({ type: z.literal('row.updated'), propertyId: basePropertyIdSchema.optional() }),
  z.object({ type: z.literal('form.submitted'), formId: z.uuid().optional() }),
  z.object({ type: z.literal('button') }),
]);

// Then: cells on the row, a new row here or in another base, a notification
// for people, or a signed POST to a URL.
export const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('set_cells'), cells: z.record(z.string(), z.unknown()) }),
  z.object({
    type: z.literal('create_row'),
    pageId: z.uuid().optional(),
    cells: z.record(z.string(), z.unknown()).default({}),
  }),
  z.object({
    type: z.literal('notify'),
    userIds: z.array(z.uuid()).max(50).optional(),
    personPropertyId: basePropertyIdSchema.optional(),
    notifyCreator: z.boolean().optional(),
    message: z.string().trim().min(1).max(500),
  }),
  z.object({
    type: z.literal('webhook'),
    url: z.url(),
    secret: z.string().max(200).optional(),
  }),
]);

export const automationSpecSchema = z.object({
  trigger: triggerSchema,
  conditions: filterGroupSchema.nullable().optional(),
  actions: z.array(actionSchema).min(1).max(10),
});

export type AutomationTrigger = z.infer<typeof triggerSchema>;
export type AutomationAction = z.infer<typeof actionSchema>;
export type AutomationSpec = z.infer<typeof automationSpecSchema>;

export const MAX_AUTOMATION_DEPTH = 3;
