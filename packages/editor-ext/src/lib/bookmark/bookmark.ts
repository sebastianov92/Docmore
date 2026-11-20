import { mergeAttributes, Node } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';

export interface BookmarkOptions {
  HTMLAttributes: Record<string, any>;
  view: any;
}

export interface BookmarkAttrs {
  url: string;
  title?: string | null;
  description?: string | null;
  image?: string | null;
  siteName?: string | null;
  favicon?: string | null;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    bookmark: {
      insertBookmark: (attrs?: Partial<BookmarkAttrs>) => ReturnType;
    };
  }
}

// A card for any web address: title, description, image and site, stored
// in the document so readers need no fetch.
export const Bookmark = Node.create<BookmarkOptions>({
  name: 'bookmark',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addOptions() {
    return { HTMLAttributes: {}, view: null };
  },

  addAttributes() {
    const attr = (name: string, dataName: string) => ({
      default: null,
      parseHTML: (el: HTMLElement) => el.getAttribute(dataName),
      renderHTML: (attrs: Record<string, any>) => (attrs[name] ? { [dataName]: attrs[name] } : {}),
    });
    return {
      url: { default: '', parseHTML: (el: HTMLElement) => el.getAttribute('data-url') ?? '', renderHTML: (attrs: Record<string, any>) => ({ 'data-url': attrs.url ?? '' }) },
      title: attr('title', 'data-title'),
      description: attr('description', 'data-description'),
      image: attr('image', 'data-image'),
      siteName: attr('siteName', 'data-site-name'),
      favicon: attr('favicon', 'data-favicon'),
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="bookmark"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, { 'data-type': 'bookmark' }),
      ['a', { href: HTMLAttributes['data-url'] ?? '', rel: 'noopener noreferrer', target: '_blank' }, HTMLAttributes['data-title'] ?? HTMLAttributes['data-url'] ?? ''],
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(this.options.view);
  },

  addCommands() {
    return {
      insertBookmark:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: { url: attrs?.url ?? '', ...attrs } }),
    };
  },
});
