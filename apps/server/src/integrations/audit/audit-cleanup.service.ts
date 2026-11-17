import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { DEFAULT_AUDIT_RETENTION_DAYS } from './audit.utils';

const DELETE_BATCH = 5000;

// Drops audit rows older than each workspace's retention. Runs shortly
// after start and then daily; deletes in batches so a big backlog never
// holds a long lock.
@Injectable()
export class AuditCleanupService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AuditCleanupService.name);
  private running = false;

  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  onApplicationBootstrap() {
    setTimeout(() => void this.run(), 60_000).unref();
  }

  @Interval('audit-cleanup', 24 * 60 * 60 * 1000)
  async scheduled() {
    await this.run();
  }

  async run(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let removed = 0;
    try {
      const workspaces = await this.db
        .selectFrom('workspaces')
        .select(['id', 'auditRetentionDays'])
        .execute();

      for (const workspace of workspaces) {
        const days = Number(workspace.auditRetentionDays ?? DEFAULT_AUDIT_RETENTION_DAYS);
        const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        removed += await this.purge(workspace.id, cutoff);
      }
      if (removed > 0) {
        this.logger.log(`Removed ${removed} expired audit row(s)`);
      }
    } catch (err: any) {
      this.logger.warn(`Audit cleanup failed: ${err?.message}`);
    } finally {
      this.running = false;
    }
    return removed;
  }

  private async purge(workspaceId: string, cutoff: Date): Promise<number> {
    let total = 0;
    for (;;) {
      const result = await sql<{ count: number }>`
        with doomed as (
          select id from audit
          where workspace_id = ${workspaceId} and created_at < ${cutoff}
          order by id asc
          limit ${DELETE_BATCH}
        )
        delete from audit where id in (select id from doomed)
      `.execute(this.db);
      const deleted = Number(result.numAffectedRows ?? 0);
      total += deleted;
      if (deleted < DELETE_BATCH) break;
    }
    return total;
  }
}
