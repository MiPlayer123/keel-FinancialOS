/** sha-256 hex of a string (browser WebCrypto). Used for source content hashes. */
export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Parse user-entered dollars into SIGNED minor units string, or null. */
export function parseSignedDollars(input: string): string | null {
  const cleaned = input.replace(/[$,\s]/g, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const negative = cleaned.startsWith('-');
  const [whole = '0', frac = ''] = cleaned.replace('-', '').split('.');
  const minor = BigInt(whole) * 100n + BigInt(frac.padEnd(2, '0') || '0');
  if (minor === 0n) return '0';
  return negative ? `-${minor.toString()}` : minor.toString();
}

/** Format signed minor units as a plain dollars string for input defaults. */
export function minorToDollars(minor: string): string {
  const negative = minor.startsWith('-');
  const magnitude = BigInt(minor.replace('-', '') || '0');
  const whole = magnitude / 100n;
  const frac = (magnitude % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${frac}`;
}
