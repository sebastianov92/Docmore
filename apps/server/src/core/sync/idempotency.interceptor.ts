import {
  BadRequestException,
  CallHandler,
  ConflictException,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { from, Observable, of } from 'rxjs';
import { mergeMap, switchMap } from 'rxjs/operators';
import { KyselyDB } from '@docmost/db/types/kysely.types';

const HEADER = 'idempotency-key';
const KEEP_DAYS = 14;
const SIX_HOURS = 6 * 60 * 60 * 1000;

// A device that was offline replays its queued writes when it reconnects. If
// the answer to one of them gets lost it sends the same write again with the
// same Idempotency-Key: the second time the stored answer is returned and
// nothing runs twice. Only successful answers are kept.
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest();
    const raw = req.headers?.[HEADER];
    const key = Array.isArray(raw) ? raw[0] : raw;
    const user = req.user?.user;
    const workspace = req.user?.workspace;
    if (!key || req.method !== 'POST' || !user?.id || !workspace?.id) return next.handle();
    if (typeof key !== 'string' || key.length > 100 || !/^[A-Za-z0-9_.:-]+$/.test(key)) {
      throw new BadRequestException('Invalid Idempotency-Key');
    }
    const route = String(req.routeOptions?.url ?? req.url ?? '').split('?')[0].slice(0, 200);

    return from(
      this.db
        .selectFrom('idempotencyKeys')
        .select(['route', 'response'])
        .where('userId', '=', user.id)
        .where('key', '=', key)
        .executeTakeFirst(),
    ).pipe(
      switchMap((existing) => {
        if (existing) {
          if (existing.route !== route) {
            throw new ConflictException('This Idempotency-Key was used for another request');
          }
          context.switchToHttp().getResponse().header('Idempotent-Replayed', 'true');
          return of((existing.response as { value?: unknown } | null)?.value);
        }
        return next.handle().pipe(
          mergeMap(async (value) => {
            try {
              await this.db
                .insertInto('idempotencyKeys')
                .values({
                  userId: user.id,
                  key,
                  workspaceId: workspace.id,
                  route,
                  // wrapped so arrays and primitives survive the jsonb round trip
                  response: { value: value ?? null } as any,
                })
                .onConflict((oc) => oc.columns(['userId', 'key']).doNothing())
                .execute();
            } catch (err) {
              // the write itself succeeded; a retry would run again, which is
              // what happens today without the header
              this.logger.warn(`could not store idempotency key: ${(err as Error)?.message}`);
            }
            return value;
          }),
        );
      }),
    );
  }

  @Interval(SIX_HOURS)
  async forgetOldKeys() {
    try {
      await sql`DELETE FROM idempotency_keys WHERE created_at < now() - make_interval(days => ${KEEP_DAYS})`.execute(
        this.db,
      );
    } catch (err) {
      this.logger.warn(`idempotency cleanup failed: ${(err as Error)?.message}`);
    }
  }
}
