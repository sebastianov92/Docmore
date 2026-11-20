import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";

export type BookmarkPasteMenuState = { from: number; to: number; url: string } | null;

export const bookmarkPasteMenuKey = new PluginKey<BookmarkPasteMenuState>("bookmarkPasteMenu");

// Range of a just-pasted web address, where "Paste as" offers a bookmark card.
export const BookmarkPasteMenuExtension = Extension.create({
  name: "bookmarkPasteMenu",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: bookmarkPasteMenuKey,
        state: {
          init: (): BookmarkPasteMenuState => null,
          apply(tr, prev): BookmarkPasteMenuState {
            const meta = tr.getMeta(bookmarkPasteMenuKey);
            if (meta !== undefined) return meta;
            if (!prev) return null;
            if (tr.selectionSet) return null;
            if (tr.docChanged) {
              const from = tr.mapping.map(prev.from);
              const to = tr.mapping.map(prev.to);
              return tr.doc.textBetween(from, Math.min(to, tr.doc.content.size), "\n", "\n") === prev.url ? { ...prev, from, to } : null;
            }
            return prev;
          },
        },
      }),
    ];
  },
});
