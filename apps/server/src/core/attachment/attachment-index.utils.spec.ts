import {
  decodePlainText,
  isIndexableExtension,
  isPlainTextExtension,
  MAX_INDEXED_TEXT_CHARS,
  normalizeExtension,
  normalizeExtractedText,
} from './attachment-index.utils';

describe('attachment-index.utils', () => {
  it('normalizes extensions with or without the dot, any case', () => {
    expect(normalizeExtension('PDF')).toBe('.pdf');
    expect(normalizeExtension('.Docx')).toBe('.docx');
    expect(normalizeExtension(' txt ')).toBe('.txt');
    expect(normalizeExtension(null)).toBe('');
  });

  it('knows which files are indexed and which are plain text', () => {
    expect(isIndexableExtension('.pdf')).toBe(true);
    expect(isIndexableExtension('DOCX')).toBe(true);
    expect(isIndexableExtension('.md')).toBe(true);
    expect(isIndexableExtension('.png')).toBe(false);
    expect(isIndexableExtension(undefined)).toBe(false);

    expect(isPlainTextExtension('.txt')).toBe(true);
    expect(isPlainTextExtension('.csv')).toBe(true);
    expect(isPlainTextExtension('.pdf')).toBe(false);
  });

  it('drops NUL bytes and control characters, squashes whitespace', () => {
    expect(
      normalizeExtractedText('a\u0000b\u0007c  \t d\r\n\r\n\r\n\r\ne \n f'),
    ).toBe('ab c d\n\ne\nf');
    expect(normalizeExtractedText(null)).toBe('');
    expect(normalizeExtractedText('   ')).toBe('');
  });

  it('caps the text at the index limit', () => {
    const long = 'x'.repeat(MAX_INDEXED_TEXT_CHARS + 500);
    expect(normalizeExtractedText(long)).toHaveLength(MAX_INDEXED_TEXT_CHARS);
  });

  it('decodes utf-8 and strips a byte order mark', () => {
    expect(decodePlainText(Buffer.from('﻿hola', 'utf8'))).toBe('hola');
    expect(decodePlainText(Buffer.from('ñandú', 'utf8'))).toBe('ñandú');
  });
});
