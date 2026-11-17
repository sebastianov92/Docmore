import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { AiChat, AiChatMessage } from '@docmost/db/types/entity.types';
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';
import { executeWithCursorPagination } from '@docmost/db/pagination/cursor-pagination';

export interface NewChatMessage {
  chatId: string;
  workspaceId: string;
  userId: string | null;
  role: 'user' | 'assistant' | 'tool';
  content: string | null;
  toolCalls?: unknown[] | null;
  metadata?: Record<string, unknown> | null;
}

const MESSAGE_FIELDS = [
  'id',
  'chatId',
  'workspaceId',
  'userId',
  'role',
  'content',
  'toolCalls',
  'metadata',
  'createdAt',
  'updatedAt',
  'deletedAt',
] as const;

// ai_chats and ai_chat_messages come from an upstream migration; the
// message tsv is filled by its trigger, which is what chat search uses.
@Injectable()
export class AiChatRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async createChat(data: { workspaceId: string; creatorId: string; title: string | null }): Promise<AiChat> {
    return this.db.insertInto('aiChats').values(data).returningAll().executeTakeFirstOrThrow();
  }

  async findChat(chatId: string, workspaceId: string): Promise<AiChat | undefined> {
    return this.db
      .selectFrom('aiChats')
      .selectAll()
      .where('id', '=', chatId)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
  }

  async listChats(creatorId: string, workspaceId: string, pagination: PaginationOptions) {
    const query = this.db
      .selectFrom('aiChats')
      .selectAll()
      .where('creatorId', '=', creatorId)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null);

    return executeWithCursorPagination(query, {
      perPage: pagination.limit,
      cursor: pagination.cursor,
      beforeCursor: pagination.beforeCursor,
      fields: [
        { expression: 'updatedAt', direction: 'desc' },
        { expression: 'id', direction: 'desc' },
      ],
      parseCursor: (cursor) => ({
        updatedAt: new Date(cursor.updatedAt as string),
        id: cursor.id,
      }),
    });
  }

  // Title match or a message whose text matches, newest chats first.
  async searchChats(creatorId: string, workspaceId: string, query: string): Promise<AiChat[]> {
    const text = query.trim();
    if (!text) return [];
    return this.db
      .selectFrom('aiChats')
      .selectAll()
      .where('creatorId', '=', creatorId)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .where((eb) =>
        eb.or([
          eb('title', 'ilike', `%${text}%`),
          eb(
            'id',
            'in',
            eb
              .selectFrom('aiChatMessages')
              .select('aiChatMessages.chatId')
              .where('aiChatMessages.workspaceId', '=', workspaceId)
              .where('aiChatMessages.deletedAt', 'is', null)
              .where(sql<boolean>`ai_chat_messages.tsv @@ plainto_tsquery('english', f_unaccent(${text}))`),
          ),
        ]),
      )
      .orderBy('updatedAt', 'desc')
      .limit(20)
      .execute();
  }

  async updateChat(chatId: string, data: { title?: string | null }): Promise<AiChat | undefined> {
    return this.db
      .updateTable('aiChats')
      .set({ ...data, updatedAt: new Date() })
      .where('id', '=', chatId)
      .returningAll()
      .executeTakeFirst();
  }

  async touchChat(chatId: string) {
    await this.db.updateTable('aiChats').set({ updatedAt: new Date() }).where('id', '=', chatId).execute();
  }

  async deleteChat(chatId: string) {
    await this.db.deleteFrom('aiChats').where('id', '=', chatId).execute();
  }

  async messages(chatId: string): Promise<AiChatMessage[]> {
    return this.db
      .selectFrom('aiChatMessages')
      .select(MESSAGE_FIELDS)
      .where('chatId', '=', chatId)
      .where('deletedAt', 'is', null)
      .orderBy('createdAt', 'asc')
      .orderBy('id', 'asc')
      .execute();
  }

  async insertMessage(data: NewChatMessage): Promise<AiChatMessage> {
    // Plain objects for jsonb: the driver serializes them.
    return this.db
      .insertInto('aiChatMessages')
      .values({
        chatId: data.chatId,
        workspaceId: data.workspaceId,
        userId: data.userId,
        role: data.role,
        content: data.content,
        toolCalls: (data.toolCalls ?? null) as any,
        metadata: (data.metadata ?? null) as any,
      })
      .returning(MESSAGE_FIELDS)
      .executeTakeFirstOrThrow();
  }
}
