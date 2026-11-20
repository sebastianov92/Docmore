import { mergeAttributes, Node } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';

export interface HtmlBlockOptions {
  HTMLAttributes: Record<string, any>;
  view: any;
}

export interface HtmlBlockAttrs {
  html: string;
  height: number;
  title: string | null;
}

export const HTML_BLOCK_DEFAULT_HEIGHT = 320;
export const HTML_BLOCK_MAX_CHARS = 200_000;

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    htmlBlock: {
      insertHtmlBlock: (attrs?: Partial<HtmlBlockAttrs>) => ReturnType;
    };
  }
}

// What a block shows is rendered inside a sandboxed iframe (scripts allowed,
// same-origin not), so the code never sees the app, its cookies or its DOM.
export function htmlBlockSrcDoc(html: string): string {
  const csp =
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https:; img-src data: https: blob:; font-src https: data:; media-src https: data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'";
  const body = String(html ?? '').slice(0, HTML_BLOCK_MAX_CHARS);
  if (/<html[\s>]/i.test(body)) {
    return body.replace(/<head[^>]*>/i, (m) => `${m}<meta http-equiv="Content-Security-Policy" content="${csp}">`);
  }
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>body{margin:0;font-family:system-ui,sans-serif;color:#1f1f1f;background:transparent}</style></head><body>${body}</body></html>`;
}

// An interactive HTML block: markup, styles and scripts kept in the
// document and shown in a sandboxed frame.
export const HtmlBlock = Node.create<HtmlBlockOptions>({
  name: 'htmlBlock',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addOptions() {
    return { HTMLAttributes: {}, view: null };
  },

  addAttributes() {
    return {
      html: {
        default: '',
        parseHTML: (el: HTMLElement) => el.getAttribute('data-html') ?? el.querySelector('template')?.innerHTML ?? '',
        renderHTML: (attrs: Record<string, any>) => ({ 'data-html': attrs.html ?? '' }),
      },
      height: {
        default: HTML_BLOCK_DEFAULT_HEIGHT,
        parseHTML: (el: HTMLElement) => Number(el.getAttribute('data-height')) || HTML_BLOCK_DEFAULT_HEIGHT,
        renderHTML: (attrs: Record<string, any>) => ({ 'data-height': String(attrs.height ?? HTML_BLOCK_DEFAULT_HEIGHT) }),
      },
      title: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-title'),
        renderHTML: (attrs: Record<string, any>) => (attrs.title ? { 'data-title': attrs.title } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="html-block"]' }];
  },

  // Exported HTML keeps the block working: the same sandboxed frame.
  renderHTML({ HTMLAttributes }) {
    const html = String(HTMLAttributes['data-html'] ?? '');
    const height = Number(HTMLAttributes['data-height']) || HTML_BLOCK_DEFAULT_HEIGHT;
    return [
      'div',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, { 'data-type': 'html-block' }),
      [
        'iframe',
        {
          sandbox: 'allow-scripts',
          referrerpolicy: 'no-referrer',
          loading: 'lazy',
          title: HTMLAttributes['data-title'] ?? 'HTML block',
          srcdoc: htmlBlockSrcDoc(html),
          style: `width:100%;height:${height}px;border:1px solid #d0d4db;border-radius:8px;background:transparent`,
        },
      ],
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(this.options.view);
  },

  addCommands() {
    return {
      insertHtmlBlock:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: { html: '', height: HTML_BLOCK_DEFAULT_HEIGHT, title: null, ...attrs } }),
    };
  },
});
