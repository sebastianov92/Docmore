import { mergeAttributes, Node } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';

export interface BaseButtonOptions {
  HTMLAttributes: Record<string, any>;
  view: any;
}

export interface BaseButtonAttrs {
  label?: string | null;
  // the base whose automation runs
  pageId?: string | null;
  automationId?: string | null;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    baseButton: {
      insertBaseButton: (attrs?: BaseButtonAttrs) => ReturnType;
    };
  }
}

// A button in a page that runs an automation of a base.
export const BaseButton = Node.create<BaseButtonOptions>({
  name: 'baseButton',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addOptions() {
    return { HTMLAttributes: {}, view: null };
  },

  addAttributes() {
    return {
      label: {
        default: 'Run',
        parseHTML: (el) => el.getAttribute('data-label') ?? 'Run',
        renderHTML: (attrs) => ({ 'data-label': attrs.label ?? 'Run' }),
      },
      pageId: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-page-id'),
        renderHTML: (attrs) => (attrs.pageId ? { 'data-page-id': attrs.pageId } : {}),
      },
      automationId: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-automation-id'),
        renderHTML: (attrs) => (attrs.automationId ? { 'data-automation-id': attrs.automationId } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="base-button"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, { 'data-type': 'base-button' }),
      HTMLAttributes['data-label'] ?? 'Run',
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(this.options.view);
  },

  addCommands() {
    return {
      insertBaseButton:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: { label: attrs?.label ?? 'Run', pageId: attrs?.pageId ?? null, automationId: attrs?.automationId ?? null },
          }),
    };
  },
});
