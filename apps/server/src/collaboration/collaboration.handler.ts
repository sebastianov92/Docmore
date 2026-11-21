import { Injectable, Logger } from '@nestjs/common';
import { Hocuspocus, Document } from '@hocuspocus/server';
import { TiptapTransformer } from '@hocuspocus/transformer';
import {
  prosemirrorNodeToYElement,
  tiptapExtensions,
} from './collaboration.util';
import { setYjsMark, updateYjsMarkAttribute, YjsSelection } from './yjs.util';
import * as Y from 'yjs';
import { User } from '@docmost/db/types/entity.types';

// Replaces every match in the text under a node, keeping the formatting of
// what it replaces. Embedded objects count as one character, as in Yjs.
function replaceInYNode(node: unknown, pattern: RegExp, to: string): number {
  if (node instanceof Y.XmlText) {
    const delta = node.toDelta() as { insert: unknown; attributes?: Record<string, any> }[];
    let text = '';
    const runs: { from: number; to: number; attributes?: Record<string, any> }[] = [];
    for (const d of delta) {
      const piece = typeof d.insert === 'string' ? d.insert : '\uFFFC';
      runs.push({ from: text.length, to: text.length + piece.length, attributes: d.attributes });
      text += piece;
    }
    const matches = [...text.matchAll(pattern)];
    for (const m of matches.reverse()) {
      const at = m.index ?? 0;
      const attributes = runs.find((r) => at >= r.from && at < r.to)?.attributes ?? {};
      node.delete(at, m[0].length);
      node.insert(at, to, attributes);
    }
    return matches.length;
  }
  if (node instanceof Y.XmlElement) {
    let count = 0;
    for (const child of node.toArray()) count += replaceInYNode(child, pattern, to);
    return count;
  }
  return 0;
}

export type CollabEventHandlers = ReturnType<
  CollaborationHandler['getHandlers']
>;

@Injectable()
export class CollaborationHandler {
  private readonly logger = new Logger(CollaborationHandler.name);

  constructor() {}

  getHandlers(hocuspocus: Hocuspocus) {
    return {
      getConnectedUserIds: async (documentName: string) => {
        const document = hocuspocus.documents.get(documentName);
        if (!document) return [];

        const userIds = new Set<string>();
        for (const state of document.awareness.getStates().values()) {
          const userId = state?.user?.id;
          if (typeof userId === 'string') userIds.add(userId);
        }
        return [...userIds];
      },
      flushDocument: async (documentName: string, _payload: object = {}) => {
        await this.flushPendingStore(hocuspocus, documentName);
      },
      alterState: async (documentName: string, payload: { pageId: string }) => {
        // dummy
        // this.logger.log('Processing', documentName, payload);
        // await this.withYdocConnection(hocuspocus, documentName, {}, (doc) => {
        //   const fragment = doc.getXmlFragment('default');
        //});
      },
      setCommentMark: async (
        documentName: string,
        payload: {
          yjsSelection: YjsSelection;
          commentId: string;
          resolved: boolean;
          user: User;
        },
      ) => {
        const { yjsSelection, commentId, resolved, user } = payload;
        await this.withYdocConnection(
          hocuspocus,
          documentName,
          { user },
          (doc) => {
            const fragment = doc.getXmlFragment('default');
            setYjsMark(doc, fragment, yjsSelection, 'comment', {
              commentId,
              resolved,
            });
          },
        );
      },
      resolveCommentMark: async (
        documentName: string,
        payload: {
          commentId: string;
          resolved: boolean;
          user: User;
        },
      ) => {
        const { commentId, resolved, user } = payload;
        await this.withYdocConnection(
          hocuspocus,
          documentName,
          { user },
          (doc) => {
            const fragment = doc.getXmlFragment('default');
            updateYjsMarkAttribute(
              fragment,
              'comment',
              { name: 'commentId', value: commentId },
              { resolved },
            );
          },
        );
      },
      // A device that worked offline: apply what it wrote and answer with what
      // it is missing, through the same document live editors share.
      syncClientUpdate: async (
        documentName: string,
        payload: { update?: string; stateVector?: string; user: User },
      ): Promise<{ update: string | null }> => {
        let diff: string | null = null;
        await this.withYdocConnection(
          hocuspocus,
          documentName,
          { user: payload.user },
          (doc) => {
            if (payload.update) {
              Y.applyUpdate(doc, new Uint8Array(Buffer.from(payload.update, 'base64')));
            }
            const stateVector = payload.stateVector
              ? new Uint8Array(Buffer.from(payload.stateVector, 'base64'))
              : undefined;
            const missing = Y.encodeStateAsUpdate(doc, stateVector);
            // two zero bytes: no structs, no deletions
            diff = missing.length > 2 ? Buffer.from(missing).toString('base64') : null;
          },
        );
        return { update: diff };
      },
      // Rewrites whole labels in the text of a page (a meeting speaker got a
      // name) through the document live editors share, so formatting and
      // what others are typing stay. With block ids, only between those two
      // blocks. Answers how many were rewritten.
      replaceText: async (
        documentName: string,
        payload: {
          pattern: string;
          flags: string;
          to: string;
          fromBlockId?: string | null;
          toBlockId?: string | null;
          user: User;
        },
      ): Promise<{ replaced: number }> => {
        let replaced = 0;
        await this.withYdocConnection(
          hocuspocus,
          documentName,
          { user: payload.user },
          (doc) => {
            const blocks = doc.getXmlFragment('default').toArray();
            const indexOf = (id?: string | null) =>
              id
                ? blocks.findIndex(
                    (b) => b instanceof Y.XmlElement && b.getAttribute('id') === id,
                  )
                : -1;
            let first = indexOf(payload.fromBlockId);
            let last = indexOf(payload.toBlockId);
            // a marker block that was deleted: that side is left open
            if (first < 0) first = 0;
            if (last < first) last = blocks.length - 1;
            const pattern = new RegExp(payload.pattern, payload.flags);
            for (let i = first; i <= last; i += 1) {
              replaced += replaceInYNode(blocks[i], pattern, payload.to);
            }
          },
        );
        return { replaced };
      },
      updatePageContent: async (
        documentName: string,
        payload: {
          prosemirrorJson: any;
          operation: string;
          user: User;
        },
      ) => {
        const { prosemirrorJson, operation, user } = payload;
        this.logger.debug('Updating page content via yjs', documentName);
        await this.withYdocConnection(
          hocuspocus,
          documentName,
          { user },
          (doc) => {
            const fragment = doc.getXmlFragment('default');

            if (operation === 'replace') {
              if (fragment.length > 0) {
                fragment.delete(0, fragment.length);
              }

              const newDoc = TiptapTransformer.toYdoc(
                prosemirrorJson,
                'default',
                tiptapExtensions,
              );
              Y.applyUpdate(doc, Y.encodeStateAsUpdate(newDoc));
            } else {
              const newContent = prosemirrorJson.content || [];
              const yElements = newContent.map(prosemirrorNodeToYElement);
              const position = operation === 'prepend' ? 0 : fragment.length;
              fragment.insert(position, yElements);
            }
          },
        );
      },
    };
  }

  async withYdocConnection(
    hocuspocus: Hocuspocus,
    documentName: string,
    context: any = {},
    fn: (doc: Document) => void,
  ): Promise<void> {
    // store pending edits first so they are not saved under this connection's user
    await this.flushPendingStore(hocuspocus, documentName);
    const connection = await hocuspocus.openDirectConnection(
      documentName,
      context,
    );
    try {
      await connection.transact(fn);
    } finally {
      await connection.disconnect();
    }
  }

  private async flushPendingStore(
    hocuspocus: Hocuspocus,
    documentName: string,
  ): Promise<void> {
    const document = hocuspocus.documents.get(documentName);
    if (!document || document.isLoading) return;
    await hocuspocus.debouncer.executeNow(`onStoreDocument-${documentName}`);
  }
}
