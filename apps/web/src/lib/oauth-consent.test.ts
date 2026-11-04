import { describe, expect, it } from 'vitest';

import { describeRedirectTarget, isRecentSignIn, safeNextPath } from './oauth-consent';

describe('safeNextPath', () => {
  it('keeps same-origin paths, including the consent query string', () => {
    expect(safeNextPath('/oauth/consent?authorization_id=abc')).toBe('/oauth/consent?authorization_id=abc');
    expect(safeNextPath('/dashboard/settings')).toBe('/dashboard/settings');
  });

  it.each([
    null,
    undefined,
    '',
    'https://evil.example/',
    '//evil.example',
    '/\\evil.example',
    'javascript:alert(1)',
    '/\t/evil.example',
    `/${'a'.repeat(3000)}`,
  ])('falls back to the dashboard for %j', (raw) => {
    expect(safeNextPath(raw)).toBe('/dashboard');
  });
});

describe('describeRedirectTarget', () => {
  it('recognizes Claude and ChatGPT callbacks', () => {
    expect(describeRedirectTarget('https://claude.ai/api/mcp/auth_callback', 'Claude')).toMatchObject({
      kind: 'claude',
      host: 'claude.ai',
      warning: null,
    });
    expect(
      describeRedirectTarget('https://chatgpt.com/connector_platform_oauth_redirect', 'ChatGPT'),
    ).toMatchObject({ kind: 'chatgpt', warning: null });
  });

  it('treats loopback http callbacks as a local app (Claude Code, Codex)', () => {
    expect(describeRedirectTarget('http://127.0.0.1:53682/callback', 'Claude Code')).toMatchObject({
      kind: 'local',
      warning: null,
    });
    expect(describeRedirectTarget('http://localhost:1455/callback', 'Codex')).toMatchObject({ kind: 'local' });
  });

  it('warns when a self-registered name impersonates a known AI product', () => {
    const target = describeRedirectTarget('https://evil.example/cb', 'Claude');
    expect(target.kind).toBe('other');
    expect(target.warning).toContain('evil.example');
    expect(target.warning).toContain('not Claude');
  });

  it('warns on any unknown https host and refuses non-https remote hosts', () => {
    expect(describeRedirectTarget('https://tools.example/cb', 'My script').warning).toContain('tools.example');
    expect(describeRedirectTarget('http://tools.example/cb', 'My script').kind).toBe('invalid');
    expect(describeRedirectTarget('not a url', 'x').kind).toBe('invalid');
  });

  it('does not treat a look-alike subdomain as Claude', () => {
    expect(describeRedirectTarget('https://claude.ai.evil.example/cb', 'Claude').kind).toBe('other');
  });
});

describe('isRecentSignIn', () => {
  const now = new Date('2026-11-04T12:00:00Z');
  it('accepts a sign-in within 15 minutes', () => {
    expect(isRecentSignIn('2026-11-04T11:50:00Z', now)).toBe(true);
  });
  it('rejects old, missing or garbage timestamps', () => {
    expect(isRecentSignIn('2026-11-04T11:00:00Z', now)).toBe(false);
    expect(isRecentSignIn(null, now)).toBe(false);
    expect(isRecentSignIn('yesterday', now)).toBe(false);
  });
});
