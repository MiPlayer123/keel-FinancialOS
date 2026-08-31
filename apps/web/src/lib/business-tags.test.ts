import { describe, expect, it } from 'vitest';

import {
  businessEntities,
  businessTagIndex,
  businessTagNames,
  isBusinessRow,
  ordinaryTags,
  rowBusinessEntityId,
  rowBusinessName,
  splitRowTags,
} from './business-tags';
import type { EntityRow, TagRow } from './keel-api';

const tag = (tagId: string, name: string, entityId: string | null = null): TagRow => ({
  tagId,
  name,
  usageCount: 0,
  entityId,
});

const entity = (entityId: string, name: string, kind: EntityRow['kind']): EntityRow => ({
  entityId,
  name,
  kind,
});

const ENTITIES: EntityRow[] = [
  entity('ent-personal', 'Household', 'personal'),
  entity('ent-acme', 'Acme LLC', 'llc_single'),
  entity('ent-beta', 'Beta Studio', 'sole_prop'),
];

const TAGS: TagRow[] = [
  tag('tag-acme', 'Acme LLC', 'ent-acme'),
  tag('tag-beta', 'Beta Studio', 'ent-beta'),
  tag('tag-reimb', 'Reimbursable'),
];

describe('businessEntities', () => {
  it('lists non-personal entities with the tag that attributes to them', () => {
    expect(businessEntities(ENTITIES, TAGS)).toEqual([
      { entityId: 'ent-acme', name: 'Acme LLC', tagId: 'tag-acme' },
      { entityId: 'ent-beta', name: 'Beta Studio', tagId: 'tag-beta' },
    ]);
  });

  it('excludes the personal entity: an unattributed transaction already means personal', () => {
    expect(businessEntities(ENTITIES, TAGS).map((b) => b.entityId)).not.toContain('ent-personal');
  });

  it('reports a business whose tag has not been minted yet with a null tagId', () => {
    // The tag is created lazily on the first attribution, so a brand-new
    // business must still be offerable in the picker.
    expect(businessEntities(ENTITIES, [tag('tag-reimb', 'Reimbursable')])).toEqual([
      { entityId: 'ent-acme', name: 'Acme LLC', tagId: null },
      { entityId: 'ent-beta', name: 'Beta Studio', tagId: null },
    ]);
  });

  it('is empty for a household with no business entity', () => {
    expect(businessEntities([entity('ent-personal', 'Household', 'personal')], TAGS)).toEqual([]);
  });
});

describe('businessTagIndex', () => {
  it('maps only business tags', () => {
    const index = businessTagIndex(TAGS);
    expect(index.get('tag-acme')).toBe('ent-acme');
    expect(index.get('tag-beta')).toBe('ent-beta');
    expect(index.has('tag-reimb')).toBe(false);
  });

  it('is empty when no tag is bound', () => {
    expect(businessTagIndex([tag('tag-reimb', 'Reimbursable')]).size).toBe(0);
  });
});

describe('rowBusinessEntityId', () => {
  const index = businessTagIndex(TAGS);

  it('finds the business behind a row carrying its tag', () => {
    const row = { tags: [{ tagId: 'tag-acme', name: 'Acme LLC' }] };
    expect(rowBusinessEntityId(row, index)).toBe('ent-acme');
  });

  it('ignores ordinary tags', () => {
    const row = { tags: [{ tagId: 'tag-reimb', name: 'Reimbursable' }] };
    expect(rowBusinessEntityId(row, index)).toBeNull();
  });

  it('finds the business tag among ordinary ones, whatever the order', () => {
    const row = {
      tags: [
        { tagId: 'tag-reimb', name: 'Reimbursable' },
        { tagId: 'tag-beta', name: 'Beta Studio' },
      ],
    };
    expect(rowBusinessEntityId(row, index)).toBe('ent-beta');
  });

  it('handles a row with no tags at all, and one with a null tag list', () => {
    expect(rowBusinessEntityId({ tags: [] }, index)).toBeNull();
    expect(rowBusinessEntityId({ tags: null }, index)).toBeNull();
    expect(rowBusinessEntityId({}, index)).toBeNull();
  });

  it('degrades rather than throwing when a stale cache shows two business tags', () => {
    // The database refuses this state (keel_tag_assign guard); a client holding
    // a page fetched across a change must still render.
    const row = {
      tags: [
        { tagId: 'tag-acme', name: 'Acme LLC' },
        { tagId: 'tag-beta', name: 'Beta Studio' },
      ],
    };
    expect(rowBusinessEntityId(row, index)).toBe('ent-acme');
  });

  it('ignores a tag id the index does not know (tag list not loaded yet)', () => {
    const row = { tags: [{ tagId: 'tag-acme', name: 'Acme LLC' }] };
    expect(rowBusinessEntityId(row, new Map())).toBeNull();
  });
});

describe('isBusinessRow', () => {
  const index = businessTagIndex(TAGS);

  it('is true only for an attributed row', () => {
    expect(isBusinessRow({ tags: [{ tagId: 'tag-acme', name: 'Acme LLC' }] }, index)).toBe(true);
    expect(isBusinessRow({ tags: [{ tagId: 'tag-reimb', name: 'Reimbursable' }] }, index)).toBe(
      false,
    );
  });
});

describe('rowBusinessName', () => {
  const index = businessTagIndex(TAGS);
  const businesses = businessEntities(ENTITIES, TAGS);

  it('names the business behind the row', () => {
    const row = { tags: [{ tagId: 'tag-beta', name: 'Beta Studio' }] };
    expect(rowBusinessName(row, index, businesses)).toBe('Beta Studio');
  });

  it('returns null for an unattributed row', () => {
    expect(rowBusinessName({ tags: [] }, index, businesses)).toBeNull();
  });

  it('falls back to the tag name when the entity list is stale', () => {
    // Entity list fetched before the business existed; tag list is newer.
    const row = { tags: [{ tagId: 'tag-beta', name: 'Beta Studio' }] };
    expect(rowBusinessName(row, index, [])).toBe('Beta Studio');
  });
});

describe('businessTagNames', () => {
  it('maps each business tag to its entity name', () => {
    const names = businessTagNames(TAGS, ENTITIES);
    expect(names.get('tag-acme')).toBe('Acme LLC');
    expect(names.get('tag-beta')).toBe('Beta Studio');
  });

  it('omits ordinary tags', () => {
    expect(businessTagNames(TAGS, ENTITIES).has('tag-reimb')).toBe(false);
  });

  it('falls back to the tag name when the entity list is stale', () => {
    expect(businessTagNames(TAGS, []).get('tag-acme')).toBe('Acme LLC');
  });

  it('prefers the entity name when the two have diverged (entity renamed)', () => {
    // Renaming the entity does not rename its tag, so the row must show the
    // entity's current name, not the stale tag label.
    const renamed = [entity('ent-acme', 'Acme Holdings LLC', 'llc_single')];
    expect(businessTagNames([tag('tag-acme', 'Acme LLC', 'ent-acme')], renamed).get('tag-acme')).toBe(
      'Acme Holdings LLC',
    );
  });
});

describe('splitRowTags', () => {
  const names = businessTagNames(TAGS, ENTITIES);

  it('pulls the business out of the row and leaves the ordinary tags', () => {
    const row = {
      tags: [
        { tagId: 'tag-reimb', name: 'Reimbursable' },
        { tagId: 'tag-acme', name: 'Acme LLC' },
      ],
    };
    expect(splitRowTags(row, names)).toEqual({
      businessName: 'Acme LLC',
      plainTags: [{ tagId: 'tag-reimb', name: 'Reimbursable' }],
    });
  });

  it('reports no business for a row that has none', () => {
    const row = { tags: [{ tagId: 'tag-reimb', name: 'Reimbursable' }] };
    expect(splitRowTags(row, names)).toEqual({
      businessName: undefined,
      plainTags: [{ tagId: 'tag-reimb', name: 'Reimbursable' }],
    });
  });

  it('handles an empty and a null tag list', () => {
    expect(splitRowTags({ tags: [] }, names)).toEqual({ businessName: undefined, plainTags: [] });
    expect(splitRowTags({ tags: null }, names)).toEqual({ businessName: undefined, plainTags: [] });
  });

  it('degrades a business tag to an ordinary chip when the caller has no map', () => {
    // A surface that has not loaded the tag list must still show the label,
    // never drop it silently.
    const row = { tags: [{ tagId: 'tag-acme', name: 'Acme LLC' }] };
    expect(splitRowTags(row, undefined)).toEqual({
      businessName: undefined,
      plainTags: [{ tagId: 'tag-acme', name: 'Acme LLC' }],
    });
  });

  it('shows the entity name on the badge even when the tag was renamed', () => {
    const renamed = businessTagNames([tag('tag-acme', 'old label', 'ent-acme')], ENTITIES);
    const row = { tags: [{ tagId: 'tag-acme', name: 'old label' }] };
    expect(splitRowTags(row, renamed).businessName).toBe('Acme LLC');
  });
});

describe('ordinaryTags', () => {
  it('hides business tags from the ordinary tag picker', () => {
    expect(ordinaryTags(TAGS).map((t) => t.tagId)).toEqual(['tag-reimb']);
  });

  it('leaves an all-ordinary list untouched', () => {
    const plain = [tag('a', 'A'), tag('b', 'B')];
    expect(ordinaryTags(plain)).toEqual(plain);
  });
});
