import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB, KyselyTransaction } from '../../types/kysely.types';
import { dbOrTx } from '../../utils';
import {
  AuthAccount,
  InsertableAuthAccount,
} from '@docmost/db/types/entity.types';

// Links a Docmore user to its identity (the `sub` claim) at one SSO provider.
@Injectable()
export class AuthAccountRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async findByProviderUser(
    authProviderId: string,
    providerUserId: string,
    opts?: { trx?: KyselyTransaction },
  ): Promise<AuthAccount | undefined> {
    const db = dbOrTx(this.db, opts?.trx);
    return db
      .selectFrom('authAccounts')
      .selectAll()
      .where('authProviderId', '=', authProviderId)
      .where('providerUserId', '=', providerUserId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
  }

  async findByUser(
    userId: string,
    authProviderId: string,
    opts?: { trx?: KyselyTransaction },
  ): Promise<AuthAccount | undefined> {
    const db = dbOrTx(this.db, opts?.trx);
    return db
      .selectFrom('authAccounts')
      .selectAll()
      .where('userId', '=', userId)
      .where('authProviderId', '=', authProviderId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
  }

  async insert(
    data: InsertableAuthAccount,
    trx?: KyselyTransaction,
  ): Promise<AuthAccount> {
    const db = dbOrTx(this.db, trx);
    return db
      .insertInto('authAccounts')
      .values(data)
      .returningAll()
      .executeTakeFirstOrThrow();
  }
}
