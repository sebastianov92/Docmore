export interface TextChunk {
  index: number;
  start: number;
  length: number;
  text: string;
}

export const CHUNK_SIZE = 1200;
export const CHUNK_OVERLAP = 200;
// Pages beyond this are indexed by their first part only.
export const MAX_CHUNKS_PER_PAGE = 400;

// Splits text into overlapping windows of about `size` characters, cutting
// at paragraph, line, sentence or word boundaries when one is close enough.
// Offsets refer to the input string.
export function chunkText(
  text: string,
  size = CHUNK_SIZE,
  overlap = CHUNK_OVERLAP,
): TextChunk[] {
  const chunks: TextChunk[] = [];
  if (!text) return chunks;
  const length = text.length;
  let start = 0;

  while (start < length) {
    let end = Math.min(start + size, length);
    if (end < length) {
      end = findBreak(text, start, end);
    }
    const raw = text.slice(start, end);
    const leading = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    if (trimmed) {
      chunks.push({
        index: chunks.length,
        start: start + leading,
        length: trimmed.length,
        text: trimmed,
      });
      if (chunks.length >= MAX_CHUNKS_PER_PAGE) break;
    }
    if (end >= length) break;
    // Overlap keeps a sentence split across two chunks findable from both.
    let next = Math.max(end - overlap, start + 1);
    while (next < end && next > start && !/\s/.test(text[next - 1])) next++;
    start = next;
  }
  return chunks;
}

// The last good boundary in the second half of the window, in order of
// preference: blank line, newline, sentence end, space.
function findBreak(text: string, start: number, end: number): number {
  const floor = start + Math.floor((end - start) / 2);
  const window = text.slice(start, end);
  const candidates = [/\n\s*\n/g, /\n/g, /[.!?…]["')\]]?\s/g, /\s/g];
  for (const pattern of candidates) {
    let best = -1;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(window)) !== null) {
      const at = start + match.index + match[0].length;
      if (at > floor && at <= end) best = at;
    }
    if (best > 0) return best;
  }
  return end;
}
