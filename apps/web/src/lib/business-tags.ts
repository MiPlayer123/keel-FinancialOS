/**
 * Business expense attribution, layer 1 — the client half.
 *
 * A business entity owns one tag (`tags.entity_id`, migration 20260831120000).
 * A transaction carrying that tag belongs to that entity's books no matter
 * which account paid for it, which is how a personal-card purchase becomes an
 * LLC expense without pretending the LLC's bank account moved. This is
 * classification only: nothing here moves money, and whether the business owes
 * the payer back is a separate economic fact (see
 * docs/BUSINESS-EXPENSE-RESEARCH.md §5).
 *
 * Every transaction read model already emits each row's tags, so attribution is
 * derived here from (row.tags × the tag list) rather than by widening
 * keel_list_transactions_rich / _rich_page. Pure functions, no I/O, unit-tested
 * in business-tags.test.ts.
 */
import type { EntityRow, TagRow } from '@/lib/keel-api';

/** The shape every transaction row already carries. */
export type TaggedRow = { tags?: { tagId: string; name: string }[] | null };

/** An entity a transaction can be attributed to, with the tag that does it. */
export type BusinessEntity = {
  entityId: string;
  name: string;
  /** Null until the entity's tag has been created (on first attribution). */
  tagId: string | null;
};

/**
 * The household's businesses, in the order the entity list gives them, each
 * paired with its business tag if one exists yet.
 *
 * 'personal' is the household's own books, which is what an unattributed
 * transaction already means, so it is never a business (the proc refuses to
 * mint a business tag for it).
 */
export function businessEntities(entities: EntityRow[], tags: TagRow[]): BusinessEntity[] {
  const tagByEntity = new Map<string, string>();
  for (const tag of tags) {
    if (tag.entityId) tagByEntity.set(tag.entityId, tag.tagId);
  }
  return entities
    .filter((entity) => entity.kind !== 'personal')
    .map((entity) => ({
      entityId: entity.entityId,
      name: entity.name,
      tagId: tagByEntity.get(entity.entityId) ?? null,
    }));
}

/** tagId → entityId, for every business tag in the household. */
export function businessTagIndex(tags: TagRow[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const tag of tags) {
    if (tag.entityId) index.set(tag.tagId, tag.entityId);
  }
  return index;
}

/**
 * The business a row is attributed to, or null.
 *
 * The database allows exactly one business tag per transaction
 * (keel_transaction_set_business replaces, keel_tag_assign refuses a second),
 * so the first match is the answer. Reading defensively rather than asserting:
 * a stale client cache must degrade to "the first business it can see", never
 * throw inside a list render.
 */
export function rowBusinessEntityId(
  row: TaggedRow,
  index: Map<string, string>,
): string | null {
  for (const tag of row.tags ?? []) {
    const entityId = index.get(tag.tagId);
    if (entityId) return entityId;
  }
  return null;
}

/** True when the row belongs to any business. */
export function isBusinessRow(row: TaggedRow, index: Map<string, string>): boolean {
  return rowBusinessEntityId(row, index) !== null;
}

/**
 * Display name for a row's business, or null when it has none.
 * Falls back to the tag's own name if the entity list is stale or narrower than
 * the tag list, so a labelled row never renders as "undefined".
 */
export function rowBusinessName(
  row: TaggedRow,
  index: Map<string, string>,
  businesses: BusinessEntity[],
): string | null {
  const entityId = rowBusinessEntityId(row, index);
  if (!entityId) return null;
  const match = businesses.find((b) => b.entityId === entityId);
  if (match) return match.name;
  const tag = (row.tags ?? []).find((t) => index.get(t.tagId) === entityId);
  return tag?.name ?? null;
}

/**
 * tagId -> the display name of the business it attributes to, for every
 * business tag in the household.
 *
 * This is what a transaction ROW needs: one lookup tells it both "is this tag
 * the business marker" and "whose", without the row having to know about
 * entities at all. Falls back to the tag's own name when the entity list is
 * stale, so a labelled row never renders blank.
 */
export function businessTagNames(tags: TagRow[], entities: EntityRow[]): Map<string, string> {
  const nameByEntity = new Map(entities.map((e) => [e.entityId, e.name]));
  const out = new Map<string, string>();
  for (const tag of tags) {
    if (tag.entityId) out.set(tag.tagId, nameByEntity.get(tag.entityId) ?? tag.name);
  }
  return out;
}

/**
 * Tags to show in the ordinary tag picker: business tags are excluded, because
 * they are set through the Business control instead. Assigning one by hand
 * still works at the database level (and is guarded there against a second
 * business), but offering both paths for the same fact invites the ambiguity
 * the guard exists to refuse.
 */
export function ordinaryTags(tags: TagRow[]): TagRow[] {
  return tags.filter((tag) => !tag.entityId);
}
