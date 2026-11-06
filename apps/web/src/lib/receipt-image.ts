/**
 * Shrink a large receipt photo in the browser before upload. Phone photos are
 * 3–5 MB; a receipt reads fine at ~2400 px on the long edge as a JPEG of a few
 * hundred KB. That keeps Storage small (Supabase Free is 1 GB) and makes each
 * model read cheaper. PDFs, small images and anything the browser can't decode
 * pass through untouched.
 */
const MAX_EDGE_PX = 2400;
const SHRINK_ABOVE_BYTES = 1_500_000;
const JPEG_QUALITY = 0.85;

/** Target pixel size for a long edge cap; never upscales. Pixels, not money. */
export function fitWithin(width: number, height: number, maxEdge = MAX_EDGE_PX): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };
  const scale = maxEdge / longest;
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}

export async function prepareReceiptFile(file: File): Promise<File> {
  if (!file.type.startsWith('image/') || file.size <= SHRINK_ABOVE_BYTES) return file;
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return file;
  try {
    const bitmap = await createImageBitmap(file);
    const size = fitWithin(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext('2d');
    if (!context) {
      bitmap.close();
      return file;
    }
    context.drawImage(bitmap, 0, 0, size.width, size.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY);
    });
    if (!blob || blob.size >= file.size) return file;
    const base = file.name.replace(/\.[^.]+$/u, '') || 'receipt';
    return new File([blob], `${base}.jpg`, { type: 'image/jpeg', lastModified: file.lastModified });
  } catch {
    return file;
  }
}
