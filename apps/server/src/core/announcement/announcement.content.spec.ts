import { isSafeAnnouncementHref, normalizeAnnouncementContent } from './announcement.content';

const doc = (nodes: any[]) => ({ type: 'doc', content: [{ type: 'paragraph', content: nodes }] });

describe('isSafeAnnouncementHref', () => {
  it('accepts http, https, mailto and in-app paths', () => {
    expect(isSafeAnnouncementHref('https://example.com/x')).toBe(true);
    expect(isSafeAnnouncementHref('http://intranet/x')).toBe(true);
    expect(isSafeAnnouncementHref('mailto:it@example.com')).toBe(true);
    expect(isSafeAnnouncementHref('/s/general/p/abc')).toBe(true);
  });

  it('refuses scripts, protocol-relative and control characters', () => {
    expect(isSafeAnnouncementHref('javascript:alert(1)')).toBe(false);
    expect(isSafeAnnouncementHref('//evil.example')).toBe(false);
    expect(isSafeAnnouncementHref('/\\evil')).toBe(false);
    expect(isSafeAnnouncementHref('/\t/evil')).toBe(false);
    expect(isSafeAnnouncementHref('')).toBe(false);
    expect(isSafeAnnouncementHref(42)).toBe(false);
  });
});

describe('normalizeAnnouncementContent', () => {
  it('keeps text runs with known marks and drops the rest', () => {
    const { content, text } = normalizeAnnouncementContent(
      doc([
        { type: 'text', text: 'Maintenance ', marks: [{ type: 'bold' }, { type: 'code' }] },
        { type: 'text', text: 'tonight', marks: [{ type: 'link', attrs: { href: 'https://status.example', target: '_blank' } }] },
        { type: 'hardBreak' },
      ]),
    );
    expect(text).toBe('Maintenance tonight');
    expect(content.content[0].content).toEqual([
      { type: 'text', text: 'Maintenance ', marks: [{ type: 'bold' }] },
      { type: 'text', text: 'tonight', marks: [{ type: 'link', attrs: { href: 'https://status.example' } }] },
    ]);
  });

  it('refuses empty, multi-paragraph, overlong and unsafe-link messages', () => {
    expect(() => normalizeAnnouncementContent(doc([]))).toThrow('required');
    expect(() => normalizeAnnouncementContent(doc([{ type: 'text', text: '   ' }]))).toThrow('required');
    expect(() =>
      normalizeAnnouncementContent({ type: 'doc', content: [doc([]).content[0], doc([]).content[0]] }),
    ).toThrow('single paragraph');
    expect(() => normalizeAnnouncementContent(doc([{ type: 'text', text: 'x'.repeat(501) }]))).toThrow('too long');
    expect(() =>
      normalizeAnnouncementContent(doc([{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: 'javascript:1' } }] }])),
    ).toThrow('Links must be');
    expect(() => normalizeAnnouncementContent('nope')).toThrow('not valid');
  });
});
