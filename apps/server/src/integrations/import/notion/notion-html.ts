// Notion blocks (as the public API returns them, children already fetched)
// to the HTML this editor parses. Pure: no network, no database.

export interface NotionRichText {
  type?: string;
  plain_text?: string;
  href?: string | null;
  annotations?: { bold?: boolean; italic?: boolean; strikethrough?: boolean; underline?: boolean; code?: boolean; color?: string };
  equation?: { expression?: string };
  mention?: { type?: string; page?: { id?: string }; database?: { id?: string } };
}

export interface NotionBlock {
  id: string;
  type: string;
  has_children?: boolean;
  children?: NotionBlock[];
  [key: string]: any;
}

export interface HtmlContext {
  // an internal link for a page or database of this import, by Notion id
  linkFor: (notionId: string) => string | null;
  // where a file hosted by Notion ends up (its link there expires); null = not kept
  fileFor: (url: string, name: string | null) => string | null;
  // block types that have no equivalent here, counted for the report
  skipped: Map<string, number>;
}

const esc = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const plainText = (rich: NotionRichText[] | undefined): string =>
  (rich ?? []).map((r) => r.plain_text ?? '').join('');

const normalId = (id: string) => id.replace(/-/g, '').toLowerCase();

// A link Notion gives for one of its own pages: "/<32 hex>" or a notion.so address.
function notionIdOf(href: string): string | null {
  const match = /(?:^\/|notion\.(?:so|com)\/(?:[^/?#]*\/)*(?:[^/?#]*-)?)([0-9a-f]{32})(?:[?#].*)?$/i.exec(href);
  return match ? match[1].toLowerCase() : null;
}

export function richTextHtml(rich: NotionRichText[] | undefined, ctx: HtmlContext): string {
  let out = '';
  for (const part of rich ?? []) {
    if (part.type === 'equation') {
      out += `<span data-type="mathInline" data-katex="true">${esc(part.equation?.expression ?? '')}</span>`;
      continue;
    }
    let html = esc(part.plain_text ?? '').replace(/\n/g, '<br>');
    if (!html) continue;
    const a = part.annotations ?? {};
    if (a.code) html = `<code>${html}</code>`;
    if (a.bold) html = `<strong>${html}</strong>`;
    if (a.italic) html = `<em>${html}</em>`;
    if (a.strikethrough) html = `<s>${html}</s>`;
    if (a.underline) html = `<u>${html}</u>`;
    if (a.color && a.color.endsWith('_background')) html = `<mark>${html}</mark>`;
    const mentioned = part.mention?.page?.id ?? part.mention?.database?.id;
    let href = part.href ?? null;
    if (mentioned) href = ctx.linkFor(normalId(mentioned)) ?? href;
    else if (href) {
      const id = notionIdOf(href);
      if (id) href = ctx.linkFor(id) ?? (href.startsWith('/') ? `https://www.notion.so${href}` : href);
    }
    if (href) html = `<a href="${esc(href)}">${html}</a>`;
    out += html;
  }
  return out;
}

const CALLOUT_TYPES: Record<string, string> = {
  red: 'danger',
  pink: 'danger',
  orange: 'warning',
  yellow: 'warning',
  brown: 'warning',
  green: 'success',
};

function calloutType(color: string | undefined): string {
  const base = (color ?? '').replace(/_background$/, '');
  return CALLOUT_TYPES[base] ?? 'info';
}

const COLUMN_LAYOUTS = ['', '', 'two_equal', 'three_equal', 'four_equal', 'five_equal'];

function fileOf(data: any): { url: string; hosted: boolean; name: string | null; caption: NotionRichText[] } | null {
  if (!data) return null;
  const hosted = data.type === 'file';
  const url = hosted ? data.file?.url : data.type === 'external' ? data.external?.url : null;
  if (typeof url !== 'string' || !url) return null;
  return { url, hosted, name: typeof data.name === 'string' ? data.name : null, caption: data.caption ?? [] };
}

function fileNameOf(url: string): string {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() ?? '');
    return last || 'file';
  } catch {
    return 'file';
  }
}

export function blocksToHtml(blocks: NotionBlock[], ctx: HtmlContext): string {
  let out = '';
  let i = 0;
  const skip = (type: string) => ctx.skipped.set(type, (ctx.skipped.get(type) ?? 0) + 1);
  const kids = (block: NotionBlock) => (block.children?.length ? blocksToHtml(block.children, ctx) : '');

  while (i < blocks.length) {
    const block = blocks[i];
    const data = block[block.type] ?? {};

    // runs of list items become one list
    if (block.type === 'bulleted_list_item' || block.type === 'numbered_list_item') {
      const tag = block.type === 'bulleted_list_item' ? 'ul' : 'ol';
      let items = '';
      while (i < blocks.length && blocks[i].type === block.type) {
        const item = blocks[i];
        items += `<li><p>${richTextHtml(item[item.type]?.rich_text, ctx)}</p>${kids(item)}</li>`;
        i++;
      }
      out += `<${tag}>${items}</${tag}>`;
      continue;
    }
    if (block.type === 'to_do') {
      let items = '';
      while (i < blocks.length && blocks[i].type === 'to_do') {
        const item = blocks[i];
        const checked = item.to_do?.checked === true;
        items +=
          `<li data-type="taskItem" data-checked="${checked}"><label><input type="checkbox"${checked ? ' checked' : ''}><span></span></label>` +
          `<div><p>${richTextHtml(item.to_do?.rich_text, ctx)}</p>${kids(item)}</div></li>`;
        i++;
      }
      out += `<ul data-type="taskList">${items}</ul>`;
      continue;
    }
    i++;

    switch (block.type) {
      case 'paragraph':
        out += `<p>${richTextHtml(data.rich_text, ctx)}</p>${kids(block)}`;
        break;
      case 'heading_1':
      case 'heading_2':
      case 'heading_3':
      case 'heading_4': {
        const level = Math.min(Number(block.type.slice(-1)), 3);
        const text = richTextHtml(data.rich_text, ctx);
        if (data.is_toggleable) {
          out += `<details><summary>${text}</summary><div data-type="detailsContent">${kids(block) || '<p></p>'}</div></details>`;
        } else {
          out += `<h${level}>${text}</h${level}>`;
        }
        break;
      }
      case 'toggle':
        out += `<details><summary>${richTextHtml(data.rich_text, ctx)}</summary><div data-type="detailsContent">${kids(block) || '<p></p>'}</div></details>`;
        break;
      case 'quote':
        out += `<blockquote><p>${richTextHtml(data.rich_text, ctx)}</p>${kids(block)}</blockquote>`;
        break;
      case 'callout': {
        const icon = data.icon?.type === 'emoji' && typeof data.icon.emoji === 'string' ? ` data-callout-icon="${esc(data.icon.emoji)}"` : '';
        out += `<div data-type="callout" data-callout-type="${calloutType(data.color)}"${icon}><p>${richTextHtml(data.rich_text, ctx)}</p>${kids(block)}</div>`;
        break;
      }
      case 'code': {
        const language = String(data.language ?? '').replace(/[^a-z0-9+#-]/gi, '');
        const cls = language && language !== 'plaintext' ? ` class="language-${language}"` : '';
        out += `<pre><code${cls}>${esc(plainText(data.rich_text))}</code></pre>`;
        if (plainText(data.caption)) out += `<p><em>${richTextHtml(data.caption, ctx)}</em></p>`;
        break;
      }
      case 'equation':
        out += `<div data-type="mathBlock" data-katex="true">${esc(String(data.expression ?? ''))}</div>`;
        break;
      case 'divider':
        out += '<hr>';
        break;
      case 'image': {
        const file = fileOf(data);
        if (!file) break;
        const src = file.hosted ? ctx.fileFor(file.url, file.name) : file.url;
        if (src) out += `<img src="${esc(src)}" alt="${esc(plainText(file.caption))}">`;
        else skip('image (file not kept)');
        if (plainText(file.caption)) out += `<p><em>${richTextHtml(file.caption, ctx)}</em></p>`;
        break;
      }
      case 'video':
      case 'audio':
      case 'file':
      case 'pdf': {
        const file = fileOf(data);
        if (!file) break;
        const name = file.name || plainText(file.caption) || fileNameOf(file.url);
        const href = file.hosted ? ctx.fileFor(file.url, name) : file.url;
        if (href) out += `<p><a href="${esc(href)}">${esc(name)}</a></p>`;
        else {
          skip(`${block.type} (file not kept)`);
          out += `<p>${esc(name)}</p>`;
        }
        break;
      }
      case 'bookmark':
      case 'embed':
      case 'link_preview': {
        const url = typeof data.url === 'string' ? data.url : '';
        if (url) out += `<p><a href="${esc(url)}">${plainText(data.caption) ? richTextHtml(data.caption, ctx) : esc(url)}</a></p>`;
        break;
      }
      case 'table': {
        const rows = (block.children ?? []).filter((row) => row.type === 'table_row');
        if (!rows.length) break;
        const body = rows
          .map((row, r) => {
            const cells = (row.table_row?.cells ?? []) as NotionRichText[][];
            return `<tr>${cells
              .map((cell, c) => {
                const head = (data.has_column_header && r === 0) || (data.has_row_header && c === 0);
                const tag = head ? 'th' : 'td';
                return `<${tag}><p>${richTextHtml(cell, ctx)}</p></${tag}>`;
              })
              .join('')}</tr>`;
          })
          .join('');
        out += `<table><tbody>${body}</tbody></table>`;
        break;
      }
      case 'column_list': {
        const columns = (block.children ?? []).filter((c) => c.type === 'column');
        const layout = COLUMN_LAYOUTS[columns.length];
        if (!layout) {
          // one column, or more than fit side by side: one after the other
          out += columns.map((c) => kids(c)).join('');
          break;
        }
        out += `<div data-type="columns" data-layout="${layout}">${columns.map((c) => `<div data-type="column">${kids(c) || '<p></p>'}</div>`).join('')}</div>`;
        break;
      }
      case 'child_page':
      case 'child_database': {
        // the page itself lands in the tree; here goes a way to it
        const href = ctx.linkFor(normalId(block.id));
        const title = esc(String(data.title ?? '') || 'Untitled');
        out += href ? `<p><a href="${esc(href)}">${title}</a></p>` : '';
        break;
      }
      case 'link_to_page': {
        const id = data.page_id ?? data.database_id;
        const href = id ? ctx.linkFor(normalId(String(id))) : null;
        if (href) out += `<p><a href="${esc(href)}">${esc(href)}</a></p>`;
        break;
      }
      case 'synced_block':
      case 'template':
      case 'column':
        out += kids(block);
        break;
      case 'table_of_contents':
      case 'breadcrumb':
        // this app draws its own
        break;
      default:
        skip(block.type === 'unsupported' ? `unsupported (${data.block_type ?? 'unknown'})` : block.type);
        out += kids(block);
        break;
    }
  }
  return out;
}
