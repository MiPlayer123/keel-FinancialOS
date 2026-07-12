const FORBIDDEN_KEYS = new Set([
  'accesstoken',
  'publictoken',
  'linktoken',
  'secret',
  'clientsecret',
  'wrappeddek',
  'ciphertext',
  'privatekey',
]);

const FORBIDDEN_VALUE = /(?:access[_-]?token|public[_-]?token|link[_-]?token|client[_-]?secret|wrapped[_-]?dek|ciphertext|private[_-]?key)/iu;
const SERIALIZED_SECRET_ASSIGNMENT = /["']secret["']\s*:/iu;

export class ExportSecretError extends Error {
  constructor(path: string, marker: string) {
    super(`Export blocked by secret-boundary marker ${marker} at ${path}.`);
    this.name = 'ExportSecretError';
  }
}

const scan = (value: unknown, path: string): void => {
  if (typeof value === 'string') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      // Non-JSON source text is still scanned by marker below.
    }
    if (Array.isArray(parsed) || (parsed !== null && typeof parsed === 'object')) {
      scan(parsed, `${path}<json>`);
    }
    const hit = FORBIDDEN_VALUE.exec(value) ?? SERIALIZED_SECRET_ASSIGNMENT.exec(value);
    if (hit) throw new ExportSecretError(path, hit[0].toLowerCase());
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      scan(item, `${path}[${index.toString()}]`);
    });
    return;
  }

  if (value === null || typeof value !== 'object' || value instanceof Date) return;

  const record = value as Record<string, unknown>;
  const isJwk = typeof record['kty'] === 'string';
  for (const [key, child] of Object.entries(record)) {
    const normalized = key.toLowerCase().replaceAll(/[_-]/gu, '');
    if (FORBIDDEN_KEYS.has(normalized) || (isJwk && normalized === 'd')) {
      throw new ExportSecretError(`${path}.${key}`, normalized);
    }
    scan(child, `${path}.${key}`);
  }
};

/** Fail closed without ever including the secret value in the error. */
export const assertNoExportSecrets = (value: unknown): void => {
  scan(value, '$');
};
