import { attachmentIdFromSrc } from './docx-export.utils';

describe('attachmentIdFromSrc', () => {
  const id = '01a1e771-0d37-759a-ab57-c44d08fe084d';

  it('reads the attachment id out of a file URL', () => {
    expect(attachmentIdFromSrc(`/api/files/${id}/photo.png`)).toBe(id);
    expect(attachmentIdFromSrc(`/files/${id}/photo.png?x=1`)).toBe(id);
    expect(attachmentIdFromSrc(`https://wiki.example/api/files/${id}/a.jpg`)).toBe(id);
  });

  it('accepts a bare attachment id', () => {
    expect(attachmentIdFromSrc(id)).toBe(id);
  });

  it('rejects anything else', () => {
    expect(attachmentIdFromSrc('https://example.com/image.png')).toBeNull();
    expect(attachmentIdFromSrc('/api/files/not-a-uuid/x.png')).toBeNull();
    expect(attachmentIdFromSrc('')).toBeNull();
    expect(attachmentIdFromSrc(undefined)).toBeNull();
  });
});
