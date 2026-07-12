export const NORMALIZER_VERSION = 'counterparty-v1' as const;

export const normalizeCounterparty = (description: string): string => {
  const normalized = description
    .toLowerCase()
    .replace(/\b\d{4}-\d{2}-\d{2}\b/gu, ' ')
    .replace(/\b(?:store|shop)\s*#?\s*\d+\b/gu, ' ')
    .replace(/(?:\s|#)\d+\s*$/gu, ' ')
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim()
    .replace(/\s+/gu, ' ');
  return normalized.length === 0 ? 'unknown' : normalized;
};
