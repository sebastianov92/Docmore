import { blocksToHtml, HtmlContext, NotionBlock, plainText, richTextHtml } from './notion-html';

const text = (content: string, annotations: Record<string, unknown> = {}, href: string | null = null) => ({
  type: 'text',
  plain_text: content,
  href,
  annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: 'default', ...annotations },
});
const block = (type: string, data: Record<string, unknown> = {}, children?: NotionBlock[], id = 'b1'): NotionBlock => ({
  id,
  type,
  has_children: Boolean(children?.length),
  children,
  [type]: data,
});
const ctxOf = (links: Record<string, string> = {}, files: Record<string, string> = {}): HtmlContext => ({
  linkFor: (id) => links[id] ?? null,
  fileFor: (url) => files[url] ?? null,
  skipped: new Map(),
});

describe('notion blocks to html', () => {
  it('writes rich text with its marks, links and equations', () => {
    const ctx = ctxOf({ aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: '/s/general/p/abc' });
    const rich = [
      text('a <b> & "c"', { bold: true }),
      text(' it', { italic: true, strikethrough: true }),
      text('code', { code: true }),
      text('link', { underline: true }, 'https://example.com/?a=1&b=2'),
      text('inner', {}, '/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      text('other', {}, 'https://www.notion.so/team/Some-page-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
      text('bg', { color: 'yellow_background' }),
      { type: 'equation', plain_text: 'x^2', equation: { expression: 'x^2 < y' } },
      { type: 'mention', plain_text: 'Roadmap', href: 'https://www.notion.so/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', mention: { type: 'page', page: { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' } }, annotations: {} },
    ];
    expect(richTextHtml(rich, ctx)).toBe(
      '<strong>a &lt;b&gt; &amp; &quot;c&quot;</strong>' +
        '<s><em> it</em></s>' +
        '<code>code</code>' +
        '<a href="https://example.com/?a=1&amp;b=2"><u>link</u></a>' +
        '<a href="/s/general/p/abc">inner</a>' +
        '<a href="https://www.notion.so/team/Some-page-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb">other</a>' +
        '<mark>bg</mark>' +
        '<span data-type="mathInline" data-katex="true">x^2 &lt; y</span>' +
        '<a href="/s/general/p/abc">Roadmap</a>',
    );
    expect(plainText(rich as any)).toBe('a <b> & "c" itcodelinkinnerotherbgx^2Roadmap');
    expect(richTextHtml([text('two\nlines')], ctx)).toBe('two<br>lines');
  });

  it('groups list items and nests their children', () => {
    const html = blocksToHtml(
      [
        block('bulleted_list_item', { rich_text: [text('one')] }, [block('bulleted_list_item', { rich_text: [text('inner')] })]),
        block('bulleted_list_item', { rich_text: [text('two')] }),
        block('numbered_list_item', { rich_text: [text('first')] }),
        block('numbered_list_item', { rich_text: [text('second')] }),
        block('paragraph', { rich_text: [text('after')] }),
        block('to_do', { rich_text: [text('done')], checked: true }),
        block('to_do', { rich_text: [text('open')], checked: false }),
      ],
      ctxOf(),
    );
    expect(html).toBe(
      '<ul><li><p>one</p><ul><li><p>inner</p></li></ul></li><li><p>two</p></li></ul>' +
        '<ol><li><p>first</p></li><li><p>second</p></li></ol>' +
        '<p>after</p>' +
        '<ul data-type="taskList">' +
        '<li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked><span></span></label><div><p>done</p></div></li>' +
        '<li data-type="taskItem" data-checked="false"><label><input type="checkbox"><span></span></label><div><p>open</p></div></li>' +
        '</ul>',
    );
  });

  it('writes headings, toggles, quotes, callouts, code, math and rules', () => {
    const html = blocksToHtml(
      [
        block('heading_1', { rich_text: [text('Title')] }),
        block('heading_4', { rich_text: [text('Small')] }),
        block('heading_2', { rich_text: [text('Folded')], is_toggleable: true }, [block('paragraph', { rich_text: [text('inside')] })]),
        block('toggle', { rich_text: [text('More')] }),
        block('quote', { rich_text: [text('Said')] }),
        block('callout', { rich_text: [text('Careful')], color: 'red_background', icon: { type: 'emoji', emoji: '!' } }),
        block('callout', { rich_text: [text('Note')], color: 'gray_background', icon: { type: 'external', external: { url: 'x' } } }),
        block('code', { rich_text: [text('if (a < b) {}')], language: 'javascript', caption: [text('sample')] }),
        block('code', { rich_text: [text('plain')], language: 'plain text' }),
        block('equation', { expression: 'e = mc^2' }),
        block('divider'),
      ],
      ctxOf(),
    );
    expect(html).toBe(
      '<h1>Title</h1><h3>Small</h3>' +
        '<details><summary>Folded</summary><div data-type="detailsContent"><p>inside</p></div></details>' +
        '<details><summary>More</summary><div data-type="detailsContent"><p></p></div></details>' +
        '<blockquote><p>Said</p></blockquote>' +
        '<div data-type="callout" data-callout-type="danger" data-callout-icon="!"><p>Careful</p></div>' +
        '<div data-type="callout" data-callout-type="info"><p>Note</p></div>' +
        '<pre><code class="language-javascript">if (a &lt; b) {}</code></pre><p><em>sample</em></p>' +
        '<pre><code>plain</code></pre>' +
        '<div data-type="mathBlock" data-katex="true">e = mc^2</div>' +
        '<hr>',
    );
  });

  it('writes tables with their header row and column', () => {
    const row = (...cells: string[]) => block('table_row', { cells: cells.map((c) => [text(c)]) });
    const html = blocksToHtml([block('table', { table_width: 2, has_column_header: true, has_row_header: true }, [row('', 'Q1'), row('Sales', '10')])], ctxOf());
    expect(html).toBe('<table><tbody><tr><th><p></p></th><th><p>Q1</p></th></tr><tr><th><p>Sales</p></th><td><p>10</p></td></tr></tbody></table>');
  });

  it('lays columns side by side, up to five', () => {
    const column = (label: string) => block('column', {}, [block('paragraph', { rich_text: [text(label)] })]);
    expect(blocksToHtml([block('column_list', {}, [column('a'), column('b')])], ctxOf())).toBe(
      '<div data-type="columns" data-layout="two_equal"><div data-type="column"><p>a</p></div><div data-type="column"><p>b</p></div></div>',
    );
    expect(blocksToHtml([block('column_list', {}, [column('only')])], ctxOf())).toBe('<p>only</p>');
    expect(blocksToHtml([block('column_list', {}, ['1', '2', '3', '4', '5', '6'].map(column))], ctxOf())).toBe('<p>1</p><p>2</p><p>3</p><p>4</p><p>5</p><p>6</p>');
  });

  it('keeps files Notion hosts, links the rest, and counts what it drops', () => {
    const ctx = ctxOf({}, { 'https://files.notion/a.png?sig=1': '/api/files/1/a.png' });
    const html = blocksToHtml(
      [
        block('image', { type: 'file', file: { url: 'https://files.notion/a.png?sig=1' }, caption: [text('A chart')] }),
        block('image', { type: 'external', external: { url: 'https://example.com/b.png' }, caption: [] }),
        block('image', { type: 'file', file: { url: 'https://files.notion/lost.png' }, caption: [] }),
        block('pdf', { type: 'external', external: { url: 'https://example.com/docs/Manual%20v2.pdf' }, caption: [] }),
        block('file', { type: 'file', file: { url: 'https://files.notion/x.zip' }, name: 'data.zip', caption: [] }),
        block('bookmark', { url: 'https://example.com', caption: [] }),
        block('embed', { url: 'https://youtu.be/x', caption: [text('Talk')] }),
      ],
      ctx,
    );
    expect(html).toBe(
      '<img src="/api/files/1/a.png" alt="A chart"><p><em>A chart</em></p>' +
        '<img src="https://example.com/b.png" alt="">' +
        '<p><a href="https://example.com/docs/Manual%20v2.pdf">Manual v2.pdf</a></p>' +
        '<p>data.zip</p>' +
        '<p><a href="https://example.com">https://example.com</a></p>' +
        '<p><a href="https://youtu.be/x">Talk</a></p>',
    );
    expect([...ctx.skipped.entries()]).toEqual([
      ['image (file not kept)', 1],
      ['file (file not kept)', 1],
    ]);
  });

  it('links sub-pages and databases of the import and passes through wrappers', () => {
    const ctx = ctxOf({ cccccccccccccccccccccccccccccccc: '/s/general/p/sub', dddddddddddddddddddddddddddddddd: '/s/general/p/db' });
    const html = blocksToHtml(
      [
        block('child_page', { title: 'Sub page' }, undefined, 'cccccccc-cccc-cccc-cccc-cccccccccccc'),
        block('child_database', { title: 'Tasks' }, undefined, 'dddddddd-dddd-dddd-dddd-dddddddddddd'),
        block('child_page', { title: 'Not imported' }, undefined, 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'),
        block('synced_block', { synced_from: null }, [block('paragraph', { rich_text: [text('shared')] })]),
        block('table_of_contents', {}),
        block('unsupported', { block_type: 'button' }),
        block('meeting_notes', {}, [block('paragraph', { rich_text: [text('notes')] })]),
      ],
      ctx,
    );
    expect(html).toBe('<p><a href="/s/general/p/sub">Sub page</a></p><p><a href="/s/general/p/db">Tasks</a></p><p>shared</p><p>notes</p>');
    expect([...ctx.skipped.entries()]).toEqual([
      ['unsupported (button)', 1],
      ['meeting_notes', 1],
    ]);
  });
});
