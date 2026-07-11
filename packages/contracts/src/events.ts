import { z } from 'zod';
import { EconomicEventKeySchema, HouseholdIdSchema, CommandIdSchema } from './ids.js';
import { ActorSchema } from './commands.js';

/**
 * Append-only domain events: permanent business history, separate from queue
 * messages (INFRA §8). Emitted inside the same transaction as the mutation.
 */
export const DomainEventSchema = z.object({
  eventId: z.uuid(),
  eventType: z.string().min(1).max(200), // e.g. 'journal.batch_posted'
  householdId: HouseholdIdSchema,
  commandId: CommandIdSchema,
  economicEventKey: EconomicEventKeySchema,
  actor: ActorSchema,
  occurredAt: z.iso.datetime(),
  payload: z.record(z.string(), z.unknown()),
});
export type DomainEvent = z.infer<typeof DomainEventSchema>;

/** Queue message: execution instruction, references only, no raw PII (INFRA §8). */
export const QueueMessageSchema = z.object({
  economicEventKey: EconomicEventKeySchema,
  jobType: z.string().min(1).max(200),
  refs: z.record(z.string(), z.string()),
});
export type QueueMessage = z.infer<typeof QueueMessageSchema>;
