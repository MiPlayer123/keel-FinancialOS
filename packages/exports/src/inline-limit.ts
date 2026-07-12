export const INLINE_EXPORT_MAX_BYTES = 5_000_000;

export const utf8ByteLength = (text: string): number => {
  let bytes = 0;
  for (const character of text) {
    const point = Number(character.codePointAt(0));
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return bytes;
};

export const isWithinInlineExportLimit = (
  serialized: string,
  limit = INLINE_EXPORT_MAX_BYTES,
): boolean => utf8ByteLength(serialized) <= limit;
