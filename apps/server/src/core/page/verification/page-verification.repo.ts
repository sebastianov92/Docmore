import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { ExpressionBuilder } from 'kysely';
import { jsonArrayFrom, jsonObjectFrom } from 'kysely/helpers/postgres';
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
import { DB } from '@docmost/db/types/db';
import { dbOrTx } from '@docmost/db/utils';
import {
  InsertablePageVerification,
  PageVerification,
  UpdatablePageVerification,
} from '@docmost/db/types/entity.types';

export interface VerifierRef {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  isPrimary: boolean;
}

// Rows of page_verifications / page_verifiers, with the people attached.
@Injectable()
export class PageVerificationRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async findByPageId(
    pageId: string,
    opts?: { trx?: KyselyTransaction; forUpdate?: boolean },
  ): Promise<PageVerification | undefined> {
    const db = dbOrTx(this.db, opts?.trx);
    return db
      .selectFrom('pageVerifications')
      .selectAll()
      .where('pageId', '=', pageId)
      .$if(Boolean(opts?.forUpdate), (qb) => qb.forUpdate())
      .executeTakeFirst();
  }

  async findVerifiers(verificationId: string, trx?: KyselyTransaction): Promise<VerifierRef[]> {
    const db = dbOrTx(this.db, trx);
    return db
      .selectFrom('pageVerifiers')
      .innerJoin('users', 'users.id', 'pageVerifiers.userId')
      .select([
        'users.id',
        'users.name',
        'users.email',
        'users.avatarUrl',
        'pageVerifiers.isPrimary',
      ])
      .where('pageVerifiers.pageVerificationId', '=', verificationId)
      .orderBy('pageVerifiers.isPrimary', 'desc')
      .orderBy('pageVerifiers.createdAt', 'asc')
      .execute();
  }

  async insert(values: InsertablePageVerification, trx?: KyselyTransaction): Promise<PageVerification> {
    const db = dbOrTx(this.db, trx);
    return db
      .insertInto('pageVerifications')
      .values(values)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async update(
    id: string,
    values: UpdatablePageVerification,
    trx?: KyselyTransaction,
  ): Promise<PageVerification> {
    const db = dbOrTx(this.db, trx);
    return db
      .updateTable('pageVerifications')
      .set({ ...values, updatedAt: new Date() })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async delete(id: string, trx?: KyselyTransaction): Promise<void> {
    const db = dbOrTx(this.db, trx);
    await db.deleteFrom('pageVerifications').where('id', '=', id).execute();
  }

  // Makes the verifier set exactly `userIds`, keeping rows that stay so
  // their primary flag and join date survive. Returns what changed.
  async syncVerifiers(
    verificationId: string,
    userIds: string[],
    addedById: string,
    trx?: KyselyTransaction,
  ): Promise<{ added: string[]; removed: string[] }> {
    const db = dbOrTx(this.db, trx);
    const current = await db
      .selectFrom('pageVerifiers')
      .select(['userId', 'isPrimary'])
      .where('pageVerificationId', '=', verificationId)
      .execute();
    const currentIds = new Set(current.map((r) => r.userId));
    const wanted = new Set(userIds);

    const removed = [...currentIds].filter((id) => !wanted.has(id));
    const added = userIds.filter((id) => !currentIds.has(id));

    if (removed.length > 0) {
      await db
        .deleteFrom('pageVerifiers')
        .where('pageVerificationId', '=', verificationId)
        .where('userId', 'in', removed)
        .execute();
    }
    if (added.length > 0) {
      const hasPrimary = current.some((r) => r.isPrimary && wanted.has(r.userId));
      await db
        .insertInto('pageVerifiers')
        .values(
          added.map((userId, index) => ({
            pageVerificationId: verificationId,
            userId,
            isPrimary: !hasPrimary && index === 0,
            addedById,
          })),
        )
        .execute();
    } else if (!current.some((r) => r.isPrimary && wanted.has(r.userId)) && userIds.length > 0) {
      await db
        .updateTable('pageVerifiers')
        .set({ isPrimary: true })
        .where('pageVerificationId', '=', verificationId)
        .where('userId', '=', userIds[0])
        .execute();
    }
    return { added, removed };
  }

  withUser(eb: ExpressionBuilder<DB, 'pageVerifications'>, column: 'verifiedById' | 'requestedById' | 'rejectedById' | 'invalidatedById', alias: string) {
    return jsonObjectFrom(
      eb
        .selectFrom('users')
        .select(['users.id', 'users.name', 'users.avatarUrl'])
        .whereRef('users.id', '=', `pageVerifications.${column}`),
    ).as(alias);
  }

  withVerifiers(eb: ExpressionBuilder<DB, 'pageVerifications'>) {
    return jsonArrayFrom(
      eb
        .selectFrom('pageVerifiers')
        .innerJoin('users', 'users.id', 'pageVerifiers.userId')
        .select(['users.id', 'users.name', 'users.avatarUrl'])
        .whereRef('pageVerifiers.pageVerificationId', '=', 'pageVerifications.id')
        .orderBy('pageVerifiers.isPrimary', 'desc')
        .orderBy('pageVerifiers.createdAt', 'asc'),
    ).as('verifiers');
  }
}
