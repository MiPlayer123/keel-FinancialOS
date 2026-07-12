import { describe, expect, it } from 'vitest';
import {
  INLINE_EXPORT_MAX_BYTES,
  isWithinInlineExportLimit,
  utf8ByteLength,
} from '../src/index.js';

describe('inline export response threshold', () => {
  it('uses exact UTF-8 bytes and rejects values above the fixed threshold', () => {
    expect(INLINE_EXPORT_MAX_BYTES).toBe(5_000_000);
    expect(utf8ByteLength('a€😀')).toBe(8);
    expect(isWithinInlineExportLimit('1234', 4)).toBe(true);
    expect(isWithinInlineExportLimit('12345', 4)).toBe(false);
  });
});
