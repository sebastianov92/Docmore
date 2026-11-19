import { ForbiddenException, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { AiSettingsService } from './ai-settings.service';

// Enforces the per-person AI limits: who may use it and how many requests
// a day. Every counted call goes through assertAllowed.
@Injectable()
export class AiUsageService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly settings: AiSettingsService,
  ) {}

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  async usedToday(workspaceId: string, userId: string): Promise<number> {
    const row = await this.db
      .selectFrom('aiUsage')
      .select('requests')
      .where('workspaceId', '=', workspaceId)
      .where('userId', '=', userId)
      .where('day', '=', this.today() as any)
      .executeTakeFirst();
    return Number(row?.requests ?? 0);
  }

  // What the client shows: the cap, today's count, and whether this person may use AI.
  async status(workspace: Workspace, user: User) {
    const { limits } = await this.settings.load(workspace.id);
    const roleOk = !limits.allowedRoles || limits.allowedRoles.includes(user.role);
    const blocked = limits.blockedUserIds.includes(user.id);
    const used = limits.dailyRequestsPerUser ? await this.usedToday(workspace.id, user.id) : 0;
    return {
      allowed: roleOk && !blocked,
      dailyRequestsPerUser: limits.dailyRequestsPerUser,
      usedToday: used,
    };
  }

  async assertAllowed(workspace: Workspace, user: User): Promise<void> {
    const { limits } = await this.settings.load(workspace.id);
    if (limits.allowedRoles && !limits.allowedRoles.includes(user.role)) {
      throw new ForbiddenException('AI is not available for your role');
    }
    if (limits.blockedUserIds.includes(user.id)) {
      throw new ForbiddenException('AI is not available for your account');
    }
    const cap = limits.dailyRequestsPerUser;
    if (!cap) return;
    const used = await this.usedToday(workspace.id, user.id);
    if (used >= cap) {
      throw new HttpException(
        {
          message: `Daily AI limit reached (${cap} requests). Try again tomorrow.`,
          reason: 'ai_limit_reached',
          limit: cap,
          used,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    await this.db
      .insertInto('aiUsage')
      .values({ workspaceId: workspace.id, userId: user.id, day: this.today() as any, requests: 1 })
      .onConflict((oc) =>
        oc.columns(['workspaceId', 'userId', 'day']).doUpdateSet({
          requests: sql`ai_usage.requests + 1`,
          updatedAt: new Date(),
        }),
      )
      .execute();
  }
}
