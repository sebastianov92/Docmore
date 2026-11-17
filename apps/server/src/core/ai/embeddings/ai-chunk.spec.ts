import { chunkText } from './ai-chunk';

describe('chunkText', () => {
  it('returns nothing for empty or blank text', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n\n  ')).toEqual([]);
  });

  it('keeps a short text as one chunk with its offsets', () => {
    const chunks = chunkText('  Hello world.  ');
    expect(chunks).toEqual([
      { index: 0, start: 2, length: 12, text: 'Hello world.' },
    ]);
  });

  it('prefers paragraph breaks and overlaps neighbours', () => {
    const para = (n: number) => `Paragraph ${n}. ` + 'word '.repeat(30).trim();
    const text = [para(1), para(2), para(3), para(4)].join('\n\n');
    const chunks = chunkText(text, 300, 60);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(300);
      expect(text.slice(chunk.start, chunk.start + chunk.length)).toBe(chunk.text);
    }
    // The first cut lands on a blank line, not inside a paragraph.
    const firstEnd = chunks[0].start + chunks[0].length;
    expect(text.slice(firstEnd, firstEnd + 2)).toBe('\n\n');
    // Each paragraph opening is whole inside some chunk.
    expect(chunks.some((c) => c.text.includes('Paragraph 2. word word'))).toBe(true);
    expect(chunks.some((c) => c.text.includes('Paragraph 3. word word'))).toBe(true);
    // Consecutive chunks share text.
    expect(chunks[1].start).toBeLessThan(firstEnd);
  });

  it('falls back to word boundaries and never splits inside a word', () => {
    const text = Array.from({ length: 200 }, (_, i) => `token${i}`).join(' ');
    const chunks = chunkText(text, 100, 20);
    for (const chunk of chunks) {
      expect(chunk.text).toMatch(/^token\d+/);
      expect(chunk.text).toMatch(/token\d+$/);
    }
    expect(chunks[chunks.length - 1].text.endsWith('token199')).toBe(true);
  });

  it('covers the whole text', () => {
    const text = 'abc '.repeat(1000);
    const chunks = chunkText(text, 500, 50);
    const last = chunks[chunks.length - 1];
    expect(last.start + last.length).toBe(text.trimEnd().length);
    expect(chunks[0].start).toBe(0);
  });
});
