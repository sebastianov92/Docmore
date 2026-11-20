import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB, KyselyTransaction } from '../../types/kysely.types';
import { dbOrTx } from '../../utils';
import {
  AuthProvider,
  InsertableAuthProvider,
  UpdatableAuthProvider,
} from '@docmost/db/types/entity.types';

// Only the SSO module reads the client secret; everything else gets the
// provider without it, plus a flag saying whether one is stored.
export type AuthProviderRow = Omit<AuthProvider, 'oidcClientSecret'> & {
  hasOidcClientSecret: boolean;
};

const hasSecret = sql<boolean>`oidc_client_secret is not null`.as(
  'hasOidcClientSecret',
);

@Injectable()
export class AuthProviderRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  private baseFields: Array<keyof AuthProvider> = [
    'id',
    'name',
    'type',
    'oidcIssuer',
    'oidcClientId',
    'samlUrl',
    'samlCertificate',
    'allowSignup',
    'isEnabled',
    'groupSync',
    'creatorId',
    'workspaceId',
    'createdAt',
    'updatedAt',
  ];

  async findById(
    providerId: string,
    workspaceId: string,
    opts?: { includeSecret?: boolean; trx?: KyselyTransaction },
  ): Promise<AuthProvider | undefined> {
    const db = dbOrTx(this.db, opts?.trx);
    return db
      .selectFrom('authProviders')
      .select(this.baseFields)
      .select(hasSecret)
      .$if(opts?.includeSecret === true, (qb) => qb.select('oidcClientSecret'))
      .where('id', '=', providerId)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst() as Promise<
      (AuthProvider & { hasOidcClientSecret: boolean }) | undefined
    >;
  }

  async list(workspaceId: string): Promise<AuthProviderRow[]> {
    return this.db
      .selectFrom('authProviders')
      .select(this.baseFields)
      .select(hasSecret)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .orderBy('createdAt', 'asc')
      .execute() as Promise<AuthProviderRow[]>;
  }

  async countEnabled(
    workspaceId: string,
    opts?: { excludeId?: string },
  ): Promise<number> {
    const row = await this.db
      .selectFrom('authProviders')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('workspaceId', '=', workspaceId)
      .where('isEnabled', '=', true)
      .where('deletedAt', 'is', null)
      .$if(!!opts?.excludeId, (qb) => qb.where('id', '!=', opts.excludeId))
      .executeTakeFirst();
    return Number(row?.count ?? 0);
  }

  async insert(data: InsertableAuthProvider): Promise<AuthProviderRow> {
    return this.db
      .insertInto('authProviders')
      .values(data)
      .returning([...this.baseFields, hasSecret])
      .executeTakeFirstOrThrow() as Promise<AuthProviderRow>;
  }

  async update(
    providerId: string,
    workspaceId: string,
    data: UpdatableAuthProvider,
  ): Promise<AuthProviderRow | undefined> {
    return this.db
      .updateTable('authProviders')
      .set({ ...data, updatedAt: new Date() })
      .where('id', '=', providerId)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .returning([...this.baseFields, hasSecret])
      .executeTakeFirst() as Promise<AuthProviderRow | undefined>;
  }

  // Hard delete: linked auth_accounts go with it (ON DELETE CASCADE).
  async delete(providerId: string, workspaceId: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('authProviders')
      .where('id', '=', providerId)
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  }
}
