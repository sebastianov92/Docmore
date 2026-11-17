// File types whose text goes into the search index. Keep the upload path
// (attachment.service) and the indexer in agreement through this list.
export const INDEXABLE_EXTENSIONS = ['.pdf', '.docx', '.txt', '.md', '.csv'];
const PLAIN_TEXT_EXTENSIONS = ['.txt', '.md', '.csv'];

// Anything bigger is skipped and marked indexed with no text: parsing it
// would hold the whole file in memory inside the worker.
export const MAX_INDEXABLE_FILE_BYTES = 50 * 1024 * 1024;
// Matches the cap the page tsvector trigger applies to text_content.
export const MAX_INDEXED_TEXT_CHARS = 1_000_000;

export function normalizeExtension(ext: string | null | undefined): string {
  const value = (ext ?? '').trim().toLowerCase();
  if (!value) return '';
  return value.startsWith('.') ? value : `.${value}`;
}

export function isIndexableExtension(ext: string | null | undefined): boolean {
  return INDEXABLE_EXTENSIONS.includes(normalizeExtension(ext));
}

export function isPlainTextExtension(ext: string | null | undefined): boolean {
  return PLAIN_TEXT_EXTENSIONS.includes(normalizeExtension(ext));
}

// Postgres rejects NUL bytes in text and the index gains nothing from
// runs of whitespace or control characters, so squash them before saving.
export function normalizeExtractedText(text: string | null | undefined): string {
  if (!text) return '';
  return text
    .replace(/\u0000/g, '')
    .replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_INDEXED_TEXT_CHARS);
}

// Strips a UTF-8 byte order mark so it does not end up as a search token.
export function decodePlainText(buffer: Buffer): string {
  const text = buffer.toString('utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
