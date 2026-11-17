import {
  escapeAttribute,
  imageExtensionFor,
  imageFileName,
  imageHtml,
  pdfHasText,
  usablePdfPages,
} from './document-import.utils';

describe('document-import.utils', () => {
  it('maps browser-friendly image types to extensions and rejects the rest', () => {
    expect(imageExtensionFor('image/png')).toBe('.png');
    expect(imageExtensionFor('IMAGE/JPEG; charset=binary')).toBe('.jpg');
    expect(imageExtensionFor('image/svg+xml')).toBe('.svg');
    expect(imageExtensionFor('image/x-emf')).toBeNull();
    expect(imageExtensionFor('image/tiff')).toBeNull();
    expect(imageExtensionFor('application/pdf')).toBeNull();
    expect(imageExtensionFor(undefined)).toBeNull();
  });

  it('numbers image files so they sort in document order', () => {
    expect(imageFileName(1, '.png')).toBe('image-001.png');
    expect(imageFileName(42, '.jpg')).toBe('image-042.jpg');
  });

  it('renders the editor image node with its attachment id', () => {
    const html = imageHtml(
      {
        attachmentId: 'att-1',
        apiFilePath: '/api/files/att-1/image-001.png',
        width: 320,
        height: 200,
      },
      'A "chart" <1>',
    );
    expect(html).toBe(
      '<img src="/api/files/att-1/image-001.png" data-attachment-id="att-1" width="320" height="200" data-align="center" alt="A &quot;chart&quot; &lt;1&gt;">',
    );
    expect(
      imageHtml({ attachmentId: 'a', apiFilePath: '/x', width: null, height: null }),
    ).toBe('<img src="/x" data-attachment-id="a" width="600" data-align="center">');
  });

  it('escapes attribute text', () => {
    expect(escapeAttribute('a & "b" <c>')).toBe('a &amp; &quot;b&quot; &lt;c&gt;');
  });

  it('keeps only pdf pages with text, trimmed, in order', () => {
    const pages = usablePdfPages([
      { page: 0, markdown: '  ', needsOcr: true },
      { page: 1, markdown: '\n# Title\n', needsOcr: false },
      { page: 2, markdown: 'body\u0000text', needsOcr: false },
    ]);
    expect(pages.map((p) => p.page)).toEqual([1, 2]);
    expect(pages[0].markdown).toBe('# Title');
    expect(pages[1].markdown).toBe('bodytext');
    expect(pdfHasText([{ page: 0, markdown: '', needsOcr: true }])).toBe(false);
  });
});
