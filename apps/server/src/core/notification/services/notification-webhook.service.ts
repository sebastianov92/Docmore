import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import { assertPublicUrl } from '../../../common/helpers/public-url';
import { nanoIdGen } from '../../../common/helpers';

export type NotificationWebhook = {
  id: string;
  type: 'slack' | 'teams';
  name: string;
  url: string;
  // notification types, or ['*']
  events: string[];
  createdAt: string;
};

const LABELS: Record<string, string> = {
  'comment.user_mention': 'mentioned you in a comment',
  'comment.created': 'commented on',
  'comment.resolved': 'resolved a comment on',
  'page.user_mention': 'mentioned you on',
  'page.permission_granted': 'gave access to',
  'page.updated': 'updated',
  'page.verified': 'verified',
  'page.approval_requested': 'asked for approval of',
  'page.approval_rejected': 'returned for revision',
  'base.automation': 'automation',
};

// Workspace-level Slack / Teams incoming webhooks that mirror notifications.
@Injectable()
export class NotificationWebhookService {
  private readonly logger = new Logger(NotificationWebhookService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly workspaceRepo: WorkspaceRepo,
    private readonly environment: EnvironmentService,
  ) {}

  read(settings: unknown): NotificationWebhook[] {
    const list = (settings as any)?.notificationWebhooks;
    return Array.isArray(list) ? list : [];
  }

  async list(workspaceId: string): Promise<NotificationWebhook[]> {
    const workspace = await this.workspaceRepo.findById(workspaceId);
    return this.read(workspace?.settings).map((h) => ({ ...h, url: maskUrl(h.url) }));
  }

  async add(workspaceId: string, input: { type: 'slack' | 'teams'; name?: string; url: string; events?: string[] }) {
    assertPublicUrl(input.url);
    if (input.url.length > 1000) throw new BadRequestException('URL too long');
    const workspace = await this.workspaceRepo.findById(workspaceId);
    const hooks = this.read(workspace?.settings);
    if (hooks.length >= 10) throw new BadRequestException('At most 10 webhooks');
    const hook: NotificationWebhook = {
      id: nanoIdGen(),
      type: input.type,
      name: (input.name?.trim() || (input.type === 'slack' ? 'Slack' : 'Teams')).slice(0, 60),
      url: input.url,
      events: input.events?.length ? input.events.slice(0, 20) : ['*'],
      createdAt: new Date().toISOString(),
    };
    await this.write(workspaceId, workspace?.settings, [...hooks, hook]);
    return { ...hook, url: maskUrl(hook.url) };
  }

  async remove(workspaceId: string, id: string) {
    const workspace = await this.workspaceRepo.findById(workspaceId);
    const hooks = this.read(workspace?.settings);
    await this.write(workspaceId, workspace?.settings, hooks.filter((h) => h.id !== id));
  }

  async test(workspaceId: string, id: string) {
    const workspace = await this.workspaceRepo.findById(workspaceId);
    const hook = this.read(workspace?.settings).find((h) => h.id === id);
    if (!hook) throw new BadRequestException('Webhook not found');
    await this.post(hook, { title: 'Docmore test', text: 'This webhook is connected.', url: this.environment.getAppUrl() });
    return { ok: true };
  }

  // Mirrors a freshly created notification to the hooks that want its type.
  async dispatch(notification: { id: string; type: string; workspaceId: string; actorId: string | null; pageId: string | null; spaceId: string | null; data: unknown }): Promise<void> {
    try {
      const workspace = await this.workspaceRepo.findById(notification.workspaceId);
      const hooks = this.read(workspace?.settings).filter((h) => h.events.includes('*') || h.events.includes(notification.type));
      if (hooks.length === 0) return;
      const actor = notification.actorId
        ? await this.db.selectFrom('users').select(['name']).where('id', '=', notification.actorId).executeTakeFirst()
        : null;
      const page = notification.pageId
        ? await this.db
            .selectFrom('pages')
            .innerJoin('spaces', 'spaces.id', 'pages.spaceId')
            .select(['pages.title', 'pages.slugId', 'spaces.slug as spaceSlug'])
            .where('pages.id', '=', notification.pageId)
            .executeTakeFirst()
        : null;
      const label = LABELS[notification.type] ?? notification.type;
      const data = (notification.data ?? {}) as Record<string, unknown>;
      const title = page?.title?.trim() || 'Untitled';
      const text =
        notification.type === 'base.automation'
          ? String(data.message ?? label)
          : `${actor?.name ?? 'Someone'} ${label} ${title}`;
      const url = page ? `${this.environment.getAppUrl()}/s/${page.spaceSlug}/p/${slugify(title)}-${page.slugId}` : this.environment.getAppUrl();
      await Promise.all(hooks.map((h) => this.post(h, { title, text, url }).catch((err) => this.logger.warn(`webhook ${h.name} failed: ${err?.message}`))));
    } catch (err: any) {
      this.logger.warn(`notification webhook dispatch failed: ${err?.message}`);
    }
  }

  private async post(hook: NotificationWebhook, msg: { title: string; text: string; url: string }): Promise<void> {
    const body =
      hook.type === 'slack'
        ? { text: `${msg.text}\n<${msg.url}|${msg.title}>` }
        : {
            type: 'message',
            attachments: [
              {
                contentType: 'application/vnd.microsoft.card.adaptive',
                content: {
                  $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
                  type: 'AdaptiveCard',
                  version: '1.4',
                  body: [{ type: 'TextBlock', text: msg.text, wrap: true }],
                  actions: [{ type: 'Action.OpenUrl', title: 'Open in Docmore', url: msg.url }],
                },
              },
            ],
          };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const res = await fetch(hook.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
      if (!res.ok) throw new Error(`answered ${res.status}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private async write(workspaceId: string, settings: unknown, hooks: NotificationWebhook[]) {
    await this.workspaceRepo.updateWorkspace({ settings: { ...((settings as any) ?? {}), notificationWebhooks: hooks } as any }, workspaceId);
  }
}

function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname.slice(0, 18)}…`;
  } catch {
    return '…';
  }
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'page';
}
