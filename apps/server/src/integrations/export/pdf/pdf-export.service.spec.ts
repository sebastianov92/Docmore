import { rewriteFileUrls } from './pdf-export.service';

describe('rewriteFileUrls', () => {
  const token = 'abc.def.ghi';

  it('routes page files through the token route and leaves the rest', () => {
    const content = {
      type: 'doc',
      content: [
        { type: 'image', attrs: { src: '/api/files/f1/cat.png', alt: 'cat', width: 100 } },
        { type: 'attachment', attrs: { url: '/files/f2/plan.pdf', name: 'plan.pdf' } },
        { type: 'image', attrs: { src: 'https://example.com/x.png' } },
        { type: 'paragraph', content: [{ type: 'text', text: '/api/files/not-an-attr' }] },
      ],
    };
    const out = rewriteFileUrls(content, token) as any;
    expect(out.content[0].attrs.src).toBe(`/api/pdf-export/files/${token}/f1/cat.png`);
    expect(out.content[0].attrs.width).toBe(100);
    expect(out.content[1].attrs.url).toBe(`/api/pdf-export/files/${token}/f2/plan.pdf`);
    expect(out.content[2].attrs.src).toBe('https://example.com/x.png');
    expect(out.content[3].content[0].text).toBe('/api/files/not-an-attr');
    // input untouched
    expect(content.content[0].attrs.src).toBe('/api/files/f1/cat.png');
  });

  it('url-encodes the token', () => {
    const out = rewriteFileUrls({ type: 'image', attrs: { src: '/files/a/b.png' } }, 'to/ken') as any;
    expect(out.attrs.src).toBe('/api/pdf-export/files/to%2Fken/a/b.png');
  });

  it('passes through non-objects', () => {
    expect(rewriteFileUrls(null, token)).toBeNull();
    expect(rewriteFileUrls('x', token)).toBe('x');
  });
});
