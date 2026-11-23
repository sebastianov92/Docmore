import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { EncryptionPurpose, EncryptionService } from '../../encryption/encryption.service';
import WorkspaceAbilityFactory from '../../../core/casl/abilities/workspace-ability.factory';
import { WorkspaceCaslAction, WorkspaceCaslSubject } from '../../../core/casl/interfaces/workspace-ability.type';
import { NotionClient, NotionError } from './notion-client';

export interface NotionConnectionView {
  id: string;
  name: string;
  // the Notion workspace it belongs to
  account: string | null;
  addedBy: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

// a workspace keeps this many at most
const MAX_CONNECTIONS = 20;

// Connections to Notion kept for the workspace: the secret of a connection
// made in Notion, stored encrypted, so an import picks one instead of
// asking for the secret again. Whoever manages the workspace settings adds
// and removes them, and only they import with them: a kept connection
// reads whatever was shared with it in Notion. The secret goes in and is
// never handed back.
@Injectable()
export class NotionConnectionService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly encryption: EncryptionService,
    private readonly workspaceAbility: WorkspaceAbilityFactory,
  ) {}

  canManage(user: User, workspace: Workspace): boolean {
    return this.workspaceAbility.createForUser(user, workspace).can(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Settings);
  }

  private assertManager(user: User, workspace: Workspace): void {
    if (!this.canManage(user, workspace)) throw new ForbiddenException();
  }

  // Empty for who cannot use them: the import then asks for a secret as before.
  async list(user: User, workspace: Workspace): Promise<NotionConnectionView[]> {
    if (!this.canManage(user, workspace)) return [];
    const rows = await this.db
      .selectFrom('notionConnections as c')
      .leftJoin('users as u', 'u.id', 'c.creatorId')
      .select(['c.id', 'c.name', 'c.account', 'c.createdAt', 'c.lastUsedAt', 'u.name as addedBy'])
      .where('c.workspaceId', '=', workspace.id)
      .orderBy('c.createdAt', 'asc')
      .execute();
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      account: row.account,
      addedBy: row.addedBy ?? null,
      createdAt: new Date(row.createdAt as any).toISOString(),
      lastUsedAt: row.lastUsedAt ? new Date(row.lastUsedAt as any).toISOString() : null,
    }));
  }

  // The secret is tried against Notion before it is kept: a wrong one is
  // turned down here, not at the next import.
  async create(user: User, workspace: Workspace, input: { name?: string; token: string }): Promise<NotionConnectionView> {
    this.assertManager(user, workspace);
    const token = String(input.token ?? '').trim();
    if (token.length < 20 || token.length > 400 || /\s/.test(token)) throw new BadRequestException('Paste the secret of your Notion connection');
    const count = await this.db
      .selectFrom('notionConnections')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('workspaceId', '=', workspace.id)
      .executeTakeFirst();
    if (Number(count?.n ?? 0) >= MAX_CONNECTIONS) throw new BadRequestException(`A workspace keeps at most ${MAX_CONNECTIONS} Notion connections`);
    let me: any;
    try {
      me = await new NotionClient(token).me();
    } catch (err: any) {
      if (err instanceof NotionError) throw new BadRequestException(err.message);
      throw err;
    }
    const account = clean(me?.bot?.workspace_name) || null;
    const name = clean(input.name) || clean(me?.name) || account || 'Notion';
    const row = await this.db
      .insertInto('notionConnections')
      .values({
        workspaceId: workspace.id,
        creatorId: user.id,
        name,
        token: this.encryption.encrypt(token, EncryptionPurpose.INTEGRATION_TOKENS),
        account,
      })
      .returning(['id', 'name', 'account', 'createdAt', 'lastUsedAt'])
      .executeTakeFirstOrThrow();
    return {
      id: row.id,
      name: row.name,
      account: row.account,
      addedBy: user.name ?? null,
      createdAt: new Date(row.createdAt as any).toISOString(),
      lastUsedAt: null,
    };
  }

  async remove(user: User, workspace: Workspace, id: string): Promise<void> {
    this.assertManager(user, workspace);
    const gone = await this.db.deleteFrom('notionConnections').where('id', '=', id).where('workspaceId', '=', workspace.id).returning('id').executeTakeFirst();
    if (!gone) throw new NotFoundException('Connection not found');
  }

  // The secret of a kept connection, for a request about to go to Notion.
  async secret(user: User, workspace: Workspace, id: string): Promise<string> {
    this.assertManager(user, workspace);
    const row = await this.db.selectFrom('notionConnections').select(['id', 'token']).where('id', '=', id).where('workspaceId', '=', workspace.id).executeTakeFirst();
    if (!row) throw new NotFoundException('Connection not found');
    await this.db.updateTable('notionConnections').set({ lastUsedAt: new Date() }).where('id', '=', row.id).execute();
    return this.encryption.decrypt(row.token, EncryptionPurpose.INTEGRATION_TOKENS);
  }
}

function clean(value: unknown): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}
