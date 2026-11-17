import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { QueueJob, QueueName } from '../../../integrations/queue/constants';
import { EXPIRY_WARNING_DAYS, warningWindowMs } from './page-verification.utils';

const HOUR_MS = 60 * 60 * 1000;

// Recurring verifications expire by the clock, not by an event, so this
// sweep hands the notification queue the ones that are about to run out or
// just did. The notification handlers already skip anyone told before.
@Injectable()
export class PageVerificationSchedulerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PageVerificationSchedulerService.name);
  private running = false;

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    @InjectQueue(QueueName.NOTIFICATION_QUEUE)
    private readonly notificationQueue: Queue,
  ) {}

  onApplicationBootstrap() {
    setTimeout(() => void this.reconcile(), 2 * 60 * 1000).unref();
  }

  @Interval('page-verification-reconcile', HOUR_MS)
  async scheduled() {
    await this.reconcile();
  }

  async reconcile(): Promise<{ expiring: number; expired: number }> {
    const counts = { expiring: 0, expired: 0 };
    if (this.running) return counts;
    this.running = true;
    try {
      const now = new Date();
      const horizon = new Date(now.getTime() + EXPIRY_WARNING_DAYS * 24 * HOUR_MS);
      const rows = await this.db
        .selectFrom('pageVerifications')
        .innerJoin('pages', 'pages.id', 'pageVerifications.pageId')
        .select([
          'pageVerifications.id',
          'pageVerifications.mode',
          'pageVerifications.periodAmount',
          'pageVerifications.periodUnit',
          'pageVerifications.expiresAt',
        ])
        .where('pageVerifications.type', '=', 'expiring')
        .where('pageVerifications.invalidatedAt', 'is', null)
        .where('pageVerifications.expiresAt', 'is not', null)
        .where('pageVerifications.expiresAt', '<=', horizon)
        .where('pages.deletedAt', 'is', null)
        .execute();

      for (const row of rows) {
        const expiresAt = new Date(row.expiresAt);
        const stamp = expiresAt.getTime();
        if (stamp <= now.getTime()) {
          await this.notificationQueue.add(
            QueueJob.PAGE_VERIFICATION_EXPIRED,
            { verificationId: row.id },
            { jobId: `verification-expired:${row.id}:${stamp}`, removeOnComplete: true, removeOnFail: true },
          );
          counts.expired++;
          continue;
        }
        const window = warningWindowMs({
          mode: (row.mode as any) ?? 'period',
          periodAmount: row.periodAmount,
          periodUnit: row.periodUnit as any,
        });
        if (stamp - now.getTime() <= window) {
          await this.notificationQueue.add(
            QueueJob.PAGE_VERIFICATION_EXPIRING,
            { verificationId: row.id },
            { jobId: `verification-expiring:${row.id}:${stamp}`, removeOnComplete: true, removeOnFail: true },
          );
          counts.expiring++;
        }
      }
      if (counts.expiring || counts.expired) {
        this.logger.log(
          `Verification sweep: ${counts.expiring} expiring, ${counts.expired} expired`,
        );
      }
    } catch (err: any) {
      this.logger.warn(`Verification sweep failed: ${err?.message}`);
    } finally {
      this.running = false;
    }
    return counts;
  }
}
