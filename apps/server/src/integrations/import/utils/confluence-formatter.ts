import * as path from 'path';
import { Cheerio, CheerioAPI, load } from 'cheerio';

// Reads the HTML export of a Confluence space (Server, Data Center or
// Cloud): index.html with the page tree, one <Title>_<id>.html per page,
// files under attachments/<pageId>/. Turns Confluence's macro markup into
// the nodes the editor understands before the generic importer runs.

export interface ConfluenceAttachment {
  href: string;
  fileName: string;
  mimeType: string;
}

export interface ConfluenceTreeEntry {
  parentFile: string | null;
  order: number;
}

const INDEX_FILE = 'index.html';

export function isIndexFile(fileName: string): boolean {
  return path.basename(fileName).toLowerCase() === INDEX_FILE;
}

// "SPACE : Page title" -> "Page title"
export function stripSpacePrefix(title: string): string {
  return title.replace(/^[^:]*?\s:\s+/, '').replace(/\s+/g, ' ').trim();
}

export function confluenceTitle($: CheerioAPI, fallback: string): string {
  const heading = $('#title-text').first().text();
  if (heading.trim()) return stripSpacePrefix(heading);
  const title = $('title').first().text();
  if (title.trim()) return stripSpacePrefix(title);
  return fallback;
}

// Confluence names files "Page-Title_123456.html"; without a title in the
// HTML, that is the best we have.
export function titleFromFileName(fileName: string): string {
  return path
    .basename(fileName, path.extname(fileName))
    .replace(/_\d+$/, '')
    .replace(/[-_]+/g, ' ')
    .trim();
}

// The last breadcrumb before the page itself, skipping the space link.
export function breadcrumbParent($: CheerioAPI): string | null {
  const links = $('#breadcrumbs a[href]')
    .toArray()
    .map((a) => cleanHref($(a).attr('href') ?? ''))
    .filter((href) => href && href.toLowerCase().endsWith('.html') && !isIndexFile(href));
  return links.length ? path.basename(links[links.length - 1]) : null;
}

// index.html lists every page as nested <ul><li><a href="Page_1.html">.
export function parseIndexTree(html: string): Map<string, ConfluenceTreeEntry> {
  const $ = load(html);
  const tree = new Map<string, ConfluenceTreeEntry>();
  const scope: Cheerio<any> = $('#main-content').length ? $('#main-content') : $.root();
  let order = 0;
  scope.find('li').each((_, li) => {
    const $li = $(li);
    const $a = $li.children('a[href]').first().length
      ? $li.children('a[href]').first()
      : $li.children().first().find('a[href]').first();
    const href = cleanHref($a.attr('href') ?? '');
    if (!href || !href.toLowerCase().endsWith('.html') || isIndexFile(href)) return;
    const file = path.basename(href);
    if (tree.has(file)) return;
    const $parentLi = $li.parent().closest('li');
    let parentFile: string | null = null;
    if ($parentLi.length) {
      const parentHref = cleanHref($parentLi.children('a[href]').first().attr('href') ?? '');
      if (parentHref && !isIndexFile(parentHref)) parentFile = path.basename(parentHref);
    }
    tree.set(file, { parentFile, order: order++ });
  });
  return tree;
}

// The "Attachments:" section lists every file with its MIME type, which
// the attachment importer uses to pair draw.io diagrams with previews.
export function pageAttachments($: CheerioAPI): ConfluenceAttachment[] {
  const out: ConfluenceAttachment[] = [];
  $('.pageSection .greybox a[href], #attachments ~ .greybox a[href]').each((_, a) => {
    const $a = $(a);
    const href = normalizeAttachmentHref($a.attr('href') ?? '');
    if (!href) return;
    const fileName = $a.text().trim() || path.basename(href);
    const trailing = (a.next && a.next.type === 'text' ? (a.next as any).data : '') ?? '';
    const mime = /\(([^()]+\/[^()]+)\)/.exec(trailing)?.[1] ?? '';
    out.push({ href, fileName, mimeType: mime.trim() });
  });
  return out;
}

export function cleanHref(href: string): string {
  return href.split('#')[0].split('?')[0].trim();
}

// Thumbnails and download links all point at the same file in the zip.
export function normalizeAttachmentHref(raw: string): string {
  let href = cleanHref(raw).replace(/^\.?\//, '');
  href = href
    .replace(/^download\/thumbnails\//, 'attachments/')
    .replace(/^download\/attachments\//, 'attachments/');
  return href;
}

const BRUSH_LANGUAGES: Record<string, string> = {
  js: 'javascript',
  jscript: 'javascript',
  javascript: 'javascript',
  ts: 'typescript',
  typescript: 'typescript',
  py: 'python',
  python: 'python',
  rb: 'ruby',
  ruby: 'ruby',
  java: 'java',
  groovy: 'groovy',
  scala: 'scala',
  kotlin: 'kotlin',
  cpp: 'cpp',
  c: 'c',
  csharp: 'csharp',
  'c#': 'csharp',
  cs: 'csharp',
  php: 'php',
  go: 'go',
  rust: 'rust',
  swift: 'swift',
  bash: 'bash',
  shell: 'bash',
  sh: 'bash',
  powershell: 'powershell',
  ps: 'powershell',
  sql: 'sql',
  xml: 'xml',
  html: 'html',
  xhtml: 'html',
  css: 'css',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  diff: 'diff',
  perl: 'perl',
  text: '',
  plain: '',
  none: '',
};

export function languageFromBrush(params: string | undefined): string {
  if (!params) return '';
  const brush = /brush:\s*([a-z#+]+)/i.exec(params)?.[1]?.toLowerCase();
  if (!brush) return '';
  return BRUSH_LANGUAGES[brush] ?? brush;
}

const LOZENGE_COLORS: Array<[RegExp, string]> = [
  [/aui-lozenge-success/, 'green'],
  [/aui-lozenge-complete/, 'green'],
  [/aui-lozenge-error/, 'red'],
  [/aui-lozenge-removed/, 'red'],
  [/aui-lozenge-current/, 'blue'],
  [/aui-lozenge-inprogress/, 'blue'],
  [/aui-lozenge-moved/, 'yellow'],
  [/aui-lozenge-new/, 'purple'],
];

export function lozengeColor(className: string | undefined): string {
  const cls = className ?? '';
  for (const [re, color] of LOZENGE_COLORS) {
    if (re.test(cls)) return color;
  }
  return 'gray';
}

const CALLOUT_BY_MACRO: Array<[RegExp, string]> = [
  [/macro-tip|aui-message-success/, 'success'],
  [/macro-note|aui-message-warning/, 'warning'],
  [/macro-warning|aui-message-error/, 'danger'],
  [/macro-information|aui-message-info/, 'info'],
];

export function calloutTypeFor(className: string | undefined): string {
  const cls = className ?? '';
  for (const [re, type] of CALLOUT_BY_MACRO) {
    if (re.test(cls)) return type;
  }
  return 'info';
}

const COLUMN_LAYOUTS = ['', '', 'two_equal', 'three_equal', 'four_equal', 'five_equal'];

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Body of a Confluence page as editor-friendly HTML.
export function confluenceBodyHtml(html: string): string {
  const $ = load(html);
  const $main = pickMain($);
  stripChrome($, $main);
  convertMacros($, $main);
  normalizeImages($, $main);
  tidy($, $main);
  return $main.html() ?? '';
}

function pickMain($: CheerioAPI): Cheerio<any> {
  for (const selector of ['#main-content', '.wiki-content', '#content', 'body']) {
    const $el = $(selector).first();
    if ($el.length) return $el;
  }
  return $.root();
}

function stripChrome($: CheerioAPI, $root: Cheerio<any>) {
  $root
    .find(
      [
        'script',
        'style',
        '.page-metadata',
        '#breadcrumb-section',
        '#title-heading',
        '.pageSection',
        '#footer',
        '.toc-macro',
        '.childpages-macro',
        '.plugin_pagetree',
        '.recently-updated',
        '.confluence-anchor-link',
        'span.aui-icon',
        'img.emoticon',
        '.hidden',
        '.expand-control-icon',
        'span.expand-control-icon',
        'div.noprint',
      ].join(','),
    )
    .remove();
}

function unwrapAll($: CheerioAPI, $root: Cheerio<any>, selector: string) {
  // Innermost first so nested wrappers unwrap cleanly.
  $root
    .find(selector)
    .get()
    .reverse()
    .forEach((el) => {
      const $el = $(el);
      $el.replaceWith($el.contents());
    });
}

function convertMacros($: CheerioAPI, $root: Cheerio<any>) {
  // Page layouts (sections with columns) before anything inside them.
  $root
    .find('div.columnLayout, div.sectionMacro')
    .get()
    .reverse()
    .forEach((el) => {
      const $layout = $(el);
      const $cells = $layout.is('.sectionMacro')
        ? $layout.find('> .sectionMacroRow > .columnMacro, > .columnMacro')
        : $layout.find('> .cell');
      const cells = $cells.toArray();
      if (cells.length <= 1) {
        $layout.replaceWith($layout.find('.innerCell').first().length ? $layout.find('.innerCell').first().contents() : $layout.contents());
        return;
      }
      const layout = COLUMN_LAYOUTS[Math.min(cells.length, 5)] ?? 'two_equal';
      const inner = cells
        .map((cell) => {
          const $cell = $(cell);
          const $content = $cell.find('.innerCell').first().length ? $cell.find('.innerCell').first() : $cell;
          return `<div data-type="column">${$content.html() ?? ''}</div>`;
        })
        .join('');
      $layout.replaceWith(`<div data-type="columns" data-layout="${layout}">${inner}</div>`);
    });
  unwrapAll($, $root, 'div.contentLayout2, div.contentLayout, div.content-wrapper, div.table-wrap, span.confluence-link, div.innerCell');

  // Code macro: <div class="code panel"> with optional header and a
  // syntaxhighlighter <pre>.
  $root
    .find('div.code.panel, pre.syntaxhighlighter-pre')
    .get()
    .reverse()
    .forEach((el) => {
      const $el = $(el);
      if ($el.is('pre') && $el.closest('div.code.panel').length) return;
      const $pre = $el.is('pre') ? $el : $el.find('pre').first();
      const title = $el.is('pre') ? '' : $el.find('.codeHeader').text().trim();
      const language = languageFromBrush($pre.attr('data-syntaxhighlighter-params'));
      const code = escapeHtml($pre.text().replace(/\r\n?/g, '\n').replace(/\n$/, ''));
      const classAttr = language ? ` class="language-${language}"` : '';
      const block = `<pre><code${classAttr}>${code}</code></pre>`;
      $el.replaceWith((title ? `<p><strong>${escapeHtml(title)}</strong></p>` : '') + block);
    });

  // Info / note / warning / tip macros and AUI messages become callouts.
  $root
    .find('div.confluence-information-macro, div.aui-message')
    .get()
    .reverse()
    .forEach((el) => {
      const $el = $(el);
      const type = calloutTypeFor($el.attr('class'));
      const title = $el.find('> p.title, > .title').first().text().trim();
      const $body = $el.find('.confluence-information-macro-body').first();
      const bodyHtml = ($body.length ? $body : $el.clone().find('> p.title, > .title').remove().end()).html() ?? '';
      const titleHtml = title ? `<p><strong>${escapeHtml(title)}</strong></p>` : '';
      $el.replaceWith(
        `<div data-type="callout" data-callout-type="${type}">${titleHtml}${bodyHtml || '<p></p>'}</div>`,
      );
    });

  // Plain panels keep their title in bold inside a neutral callout.
  $root
    .find('div.panel')
    .not('.code')
    .get()
    .reverse()
    .forEach((el) => {
      const $el = $(el);
      const title = $el.find('> .panelHeader').first().text().trim();
      const $content = $el.find('> .panelContent').first();
      const bodyHtml = ($content.length ? $content : $el).html() ?? '';
      const titleHtml = title ? `<p><strong>${escapeHtml(title)}</strong></p>` : '';
      $el.replaceWith(`<div data-type="callout" data-callout-type="default">${titleHtml}${bodyHtml}</div>`);
    });

  // Expand macro -> details.
  $root
    .find('div.expand-container')
    .get()
    .reverse()
    .forEach((el) => {
      const $el = $(el);
      const summary = $el.find('.expand-control-text').first().text().trim() || 'Details';
      const $content = $el.find('.expand-content').first();
      const bodyHtml = ($content.length ? $content : $el).html() ?? '';
      $el.replaceWith(
        `<details><summary>${escapeHtml(summary)}</summary><div data-type="detailsContent">${bodyHtml}</div></details>`,
      );
    });

  // Status lozenges.
  $root.find('span.status-macro, span.aui-lozenge').each((_, el) => {
    const $el = $(el);
    const text = $el.text().trim();
    if (!text) {
      $el.remove();
      return;
    }
    $el.replaceWith(
      `<span data-type="status" data-color="${lozengeColor($el.attr('class'))}">${escapeHtml(text)}</span>`,
    );
  });

  // Task lists.
  $root.find('ul.inline-task-list').each((_, list) => {
    const $list = $(list);
    const items = $list
      .children('li')
      .toArray()
      .map((li) => {
        const $li = $(li);
        const checked = $li.hasClass('checked');
        const inner = $li.html() ?? '';
        const content = /<(p|div|ul|ol)\b/i.test(inner) ? inner : `<p>${inner}</p>`;
        return `<li data-type="taskItem" data-checked="${checked}"><label><input type="checkbox"${checked ? ' checked' : ''}><span></span></label><div>${content}</div></li>`;
      })
      .join('');
    $list.replaceWith(`<ul data-type="taskList">${items}</ul>`);
  });

  // People and dates become plain text.
  $root.find('a.confluence-userlink, .user-mention, span.confluence-userlink').each((_, el) => {
    const $el = $(el);
    $el.replaceWith(escapeHtml($el.text().trim() || '@user'));
  });
  $root.find('time[datetime]').each((_, el) => {
    const $el = $(el);
    $el.replaceWith(escapeHtml($el.attr('datetime') ?? $el.text()));
  });

  unwrapAll(
    $,
    $root,
    'div.confluence-embedded-file-wrapper, span.confluence-embedded-file-wrapper, div.confluence-content-image-border, span.confluence-embedded-file-wrapper',
  );
}

// Confluence often shows a thumbnail while data-image-src names the file.
function normalizeImages($: CheerioAPI, $root: Cheerio<any>) {
  $root.find('img').each((_, el) => {
    const $img = $(el);
    const preferred = $img.attr('data-image-src') || $img.attr('data-linked-resource-default-alias') || $img.attr('src') || '';
    if (!preferred || /^(https?:)?\/\//i.test(preferred) || preferred.startsWith('data:')) {
      if (/^(https?:)?\/\//i.test(preferred)) $img.attr('src', preferred);
      return;
    }
    $img.attr('src', normalizeAttachmentHref(preferred));
    for (const attr of [
      'data-image-src',
      'data-base-url',
      'data-linked-resource-id',
      'data-linked-resource-version',
      'data-linked-resource-type',
      'data-linked-resource-default-alias',
      'data-linked-resource-container-id',
      'data-linked-resource-container-version',
      'data-unresolved-comment-count',
      'data-media-id',
      'data-media-type',
      'loading',
    ]) {
      $img.removeAttr(attr);
    }
  });
  $root.find('a[href]').each((_, el) => {
    const $a = $(el);
    const href = $a.attr('href') ?? '';
    if (/^(https?:|mailto:|#)/i.test(href)) return;
    if (/^(download\/)?(attachments|thumbnails)\//.test(href.replace(/^\.?\//, ''))) {
      $a.attr('href', normalizeAttachmentHref(href));
    }
  });
}

function tidy($: CheerioAPI, $root: Cheerio<any>) {
  $root.find('p').each((_, el) => {
    const $p = $(el);
    const text = $p.text().replace(/\u00a0/g, ' ').trim();
    if (!text && $p.children().not('br').length === 0) $p.remove();
  });
  $root.find('[style]').removeAttr('style');
  // Confluence classes mean nothing to the editor; language-* on <code> does.
  $root.find('[class]').not('code').each((_, el) => {
    const $el = $(el);
    if (!$el.attr('data-type')) $el.removeAttr('class');
  });
}
