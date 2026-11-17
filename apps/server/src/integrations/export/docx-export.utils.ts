import { validate as isValidUUID } from 'uuid';

export const DOCX_MIME_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// Editor images point at /api/files/<attachmentId>/<name>; some nodes only carry the id.
export function attachmentIdFromSrc(src: unknown): string | null {
  if (typeof src !== 'string' || !src) {
    return null;
  }
  if (isValidUUID(src)) {
    return src;
  }
  const match = src.match(/\/files\/([0-9a-f-]{36})(?:[/?#]|$)/i);
  return match && isValidUUID(match[1]) ? match[1] : null;
}
