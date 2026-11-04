/**
 * Pure helpers for the AI-connector consent flow (/oauth/consent) and the
 * login hand-off back to it. Kept free of React and Supabase so every rule is
 * unit-tested.
 */

const DEFAULT_NEXT = '/dashboard';

/**
 * Where to send the user after sign-in. Only same-origin absolute paths are
 * allowed — `//evil.example`, `/\evil.example`, `https://…` and anything
 * with control characters fall back to the dashboard (open-redirect guard).
 */
export function safeNextPath(raw: string | null | undefined): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return DEFAULT_NEXT;
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return DEFAULT_NEXT;
  // Reject control characters (tabs/newlines are stripped by URL parsers and
  // can turn "/\t/evil" into "//evil").
  for (let i = 0; i < raw.length; i++) {
    if (raw.charCodeAt(i) < 0x20 || raw.charCodeAt(i) === 0x7f) return DEFAULT_NEXT;
  }
  return raw;
}

export type RedirectKind = 'claude' | 'chatgpt' | 'local' | 'other' | 'invalid';

export interface RedirectTarget {
  readonly kind: RedirectKind;
  /** Host the authorization code will be sent to (what the user must trust). */
  readonly host: string;
  /** Plain-language description for the consent screen. */
  readonly label: string;
  /**
   * Set when the client's self-chosen name claims a well-known AI product but
   * the code would go somewhere else. Client names come from Dynamic Client
   * Registration and are NOT verified by anyone.
   */
  readonly warning: string | null;
}

const KNOWN_HOSTS: Readonly<Record<string, { kind: RedirectKind; label: string }>> = {
  'claude.ai': { kind: 'claude', label: 'Claude (claude.ai)' },
  'claude.com': { kind: 'claude', label: 'Claude (claude.com)' },
  'chatgpt.com': { kind: 'chatgpt', label: 'ChatGPT (chatgpt.com)' },
};

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const BRAND_PATTERNS: readonly { re: RegExp; kind: RedirectKind; brand: string }[] = [
  { re: /claude|anthropic/i, kind: 'claude', brand: 'Claude' },
  { re: /chatgpt|openai/i, kind: 'chatgpt', brand: 'ChatGPT' },
];

/** Describe who receives the authorization code, and warn on brand spoofing. */
export function describeRedirectTarget(redirectUri: string, clientName: string): RedirectTarget {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return { kind: 'invalid', host: '', label: 'an unrecognized address', warning: 'This request has no valid return address. Deny it.' };
  }

  const host = url.hostname.toLowerCase();
  const known = KNOWN_HOSTS[host];
  const isLoopback = LOOPBACK_HOSTS.has(host) && url.protocol === 'http:';

  let kind: RedirectKind;
  let label: string;
  if (known && url.protocol === 'https:') {
    kind = known.kind;
    label = known.label;
  } else if (isLoopback) {
    kind = 'local';
    label = 'an app on this computer (for example Claude Code or Codex)';
  } else if (url.protocol === 'https:') {
    kind = 'other';
    label = host;
  } else {
    return { kind: 'invalid', host, label: host, warning: 'This app uses an insecure return address. Deny it.' };
  }

  let warning: string | null = null;
  for (const { re, kind: brandKind, brand } of BRAND_PATTERNS) {
    if (re.test(clientName) && kind !== brandKind && kind !== 'local') {
      warning = `This app calls itself "${clientName}", but it would receive access at ${host}, which is not ${brand}. Only continue if you set this up yourself.`;
      break;
    }
  }
  if (warning === null && kind === 'other') {
    warning = `Access would be sent to ${host}. Only continue if you trust that site.`;
  }

  return { kind, host, label, warning };
}

/**
 * Step-up for issuing AI-connector access (INFRA §7: "issue future API/MCP
 * tokens" is a high-risk operation). Prototype rule: the KEEL sign-in must be
 * recent; otherwise the user signs in again first. MFA-based step-up is a
 * security-review (⚑) follow-up.
 */
export const CONSENT_MAX_SIGN_IN_AGE_MS = 15 * 60 * 1000;

export function isRecentSignIn(lastSignInAt: string | null | undefined, now: Date): boolean {
  if (!lastSignInAt) return false;
  const at = Date.parse(lastSignInAt);
  if (!Number.isFinite(at)) return false;
  const age = now.getTime() - at;
  return age >= -60_000 && age <= CONSENT_MAX_SIGN_IN_AGE_MS;
}
