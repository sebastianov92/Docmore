import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { createHash, randomBytes } from 'crypto';
import { KyselyDB } from '@docmost/db/types/kysely.types';

// Bearer tokens the identity provider uses on /scim/v2; only a hash is kept.
@Injectable()
export class ScimTokenService {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async list(workspaceId: string) {
    return this.db
      .selectFrom('scimTokens')
      .select(['id', 'name', 'tokenLastFour', 'isEnabled', 'lastUsedAt', 'createdAt'])
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .orderBy('createdAt', 'desc')
      .execute();
  }

  // The plain token is shown once.
  async create(workspaceId: string, userId: string, name: string) {
    const token = `scim_${randomBytes(24).toString('hex')}`;
    const row = await this.db
      .insertInto('scimTokens')
      .values({ workspaceId, creatorId: userId, name: name.trim() || 'SCIM', tokenHash: hash(token), tokenLastFour: token.slice(-4), isEnabled: true })
      .returning(['id', 'name', 'tokenLastFour', 'isEnabled', 'createdAt'])
      .executeTakeFirstOrThrow();
    return { ...row, token };
  }

  async revoke(workspaceId: string, id: string) {
    const res = await this.db.updateTable('scimTokens').set({ deletedAt: new Date(), isEnabled: false }).where('id', '=', id).where('workspaceId', '=', workspaceId).executeTakeFirst();
    if (!Number(res.numUpdatedRows ?? 0)) throw new NotFoundException('Token not found');
  }

  async verify(token: string, workspaceId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('scimTokens')
      .select(['id'])
      .where('workspaceId', '=', workspaceId)
      .where('tokenHash', '=', hash(token))
      .where('isEnabled', '=', true)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
    if (!row) return false;
    void this.db.updateTable('scimTokens').set({ lastUsedAt: new Date() }).where('id', '=', row.id).execute().catch(() => undefined);
    return true;
  }
}

function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
