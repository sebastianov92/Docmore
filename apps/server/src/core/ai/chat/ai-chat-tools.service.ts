import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { Page, User, Workspace } from '@docmost/db/types/entity.types';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import SpaceAbilityFactory from '../../casl/abilities/space-ability.factory';
import { SpaceCaslAction, SpaceCaslSubject } from '../../casl/interfaces/space-ability.type';
import { PageAccessService } from '../../page/page-access/page-access.service';
import { PageService } from '../../page/services/page.service';
import { PageSuggestionService, SuggestionOperation } from '../../page/suggestions/page-suggestion.service';
import { SearchService } from '../../search/search.service';
import { AUDIT_SERVICE, IAuditService } from '../../../integrations/audit/audit.service';
import { AuditEvent, AuditResource } from '../../../common/events/audit-events';
import { validate as isValidUUID } from 'uuid';
import { jsonToMarkdown } from '../../../collaboration/collaboration.util';
import { AiEmbeddingService } from '../embeddings/ai-embedding.service';
import { AiSettingsService } from '../ai-settings.service';
import { MAX_TOOL_PAGE_CHARS } from './ai-chat.constants';
import { AiBaseToolsService } from './ai-base-tools.service';

export interface ToolContext {
  user: User;
  workspace: Workspace;
  readOnly: boolean;
  // true: an existing page is never changed directly; the change is filed
  // as a suggestion for a person to accept
  suggestEdits?: boolean;
  // who is using the tools, kept on the suggestions they file
  origin?: 'chat' | 'agent' | 'mcp';
  originLabel?: string | null;
  // a scheduled agent kept to one space: nothing outside it is seen or touched
  spaceId?: string | null;
  // what "since the last time" means when a tool is not told a date
  since?: Date | null;
}

export interface ToolDefinition {
  name: string;
  description: string;
  scope: 'read' | 'write';
  schema: any;
  execute: (args: any) => Promise<unknown>;
}

export interface PageRef {
  id: string;
  title: string;
  slugId: string;
  spaceSlug: string | null;
  url: string;
}

// What the chat model can do in the workspace, always as the asking user:
// read tools go through the same membership and page-permission checks as
// the UI, write tools through the same ones the page API enforces. Each
// tool returns plain data, or {error} so the model can tell the user.
@Injectable()
export class AiChatToolsService {
  private readonly logger = new Logger(AiChatToolsService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly pageRepo: PageRepo,
    private readonly spaceMemberRepo: SpaceMemberRepo,
    private readonly pagePermissionRepo: PagePermissionRepo,
    private readonly spaceAbility: SpaceAbilityFactory,
    private readonly pageAccess: PageAccessService,
    private readonly pageService: PageService,
    private readonly suggestions: PageSuggestionService,
    private readonly searchService: SearchService,
    private readonly embeddings: AiEmbeddingService,
    private readonly settings: AiSettingsService,
    @Inject(AUDIT_SERVICE) private readonly audit: IAuditService,
    private readonly baseTools: AiBaseToolsService,
  ) {}

  // The tools as plain definitions: the chat turns them into AI SDK tools,
  // the MCP server registers them for outside assistants. Write tools are
  // left out in read-only mode.
  async definitions(ctx: ToolContext): Promise<ToolDefinition[]> {
    const { z } = await import('zod');
    const guard =
      <A, R>(name: string, fn: (args: A) => Promise<R>) =>
      async (args: A) => {
        try {
          return await fn(args);
        } catch (err: any) {
          this.logger.debug(`tool ${name} failed: ${err?.message}`);
          return { error: friendly(err) };
        }
      };

    const defs: ToolDefinition[] = [
      {
        name: 'get_current_user',
        scope: 'read',
        description: 'Who is connected: the user and the workspace these tools act in.',
        schema: z.object({}),
        execute: guard('get_current_user', async () => ({
          user: { id: ctx.user.id, name: ctx.user.name, email: ctx.user.email },
          workspace: { id: ctx.workspace.id, name: ctx.workspace.name },
        })),
      },
      {
        name: 'list_spaces',
        scope: 'read',
        description:
          'List the spaces this user can read, with their ids. Use it to find a spaceId before searching one space or creating a page.',
        schema: z.object({}),
        execute: guard('list_spaces', async () => this.listSpaces(ctx)),
      },
      {
        name: 'list_pages',
        scope: 'read',
        description: 'The most recently updated pages of a space, with ids and urls, newest first.',
        schema: z.object({
          spaceId: z.string().uuid(),
          limit: z.number().int().min(1).max(100).default(25),
        }),
        execute: guard('list_pages', async ({ spaceId, limit }: { spaceId: string; limit?: number }) =>
          this.listPages(ctx, spaceId, limit ?? 25),
        ),
      },
      {
        name: 'search_pages',
        scope: 'read',
        description:
          'Find pages in the workspace by meaning or keywords. Returns the closest pages with an excerpt and a url; call get_page to read one in full before answering from it.',
        schema: z.object({
          query: z.string().min(1).max(500).describe('What to look for, as a question or keywords'),
          spaceId: z.string().uuid().optional().describe('Limit the search to this space'),
        }),
        execute: guard('search_pages', async ({ query, spaceId }: { query: string; spaceId?: string }) =>
          this.searchPages(ctx, query, spaceId),
        ),
      },
      {
        name: 'get_page',
        scope: 'read',
        description: 'Read one page: its title, url and full content as Markdown. Takes the page id or slugId.',
        schema: z.object({
          pageId: z.string().min(1).max(100).describe('The page id or slugId'),
        }),
        execute: guard('get_page', async ({ pageId }: { pageId: string }) => this.getPage(ctx, pageId)),
      },
      {
        name: 'list_changed_pages',
        scope: 'read',
        description:
          'The pages created or edited since a date, newest first, with who changed them last. For "what changed this week" and similar. ' +
          'Without a date it goes back to the last time (a scheduled agent: its previous run), or seven days.',
        schema: z.object({
          since: z.string().max(40).optional().describe('ISO date or date and time, for example 2026-11-16'),
          spaceId: z.string().uuid().optional(),
          limit: z.number().int().min(1).max(100).optional(),
        }),
        execute: guard('list_changed_pages', async (args: { since?: string; spaceId?: string; limit?: number }) =>
          this.listChangedPages(ctx, args),
        ),
      },
      {
        name: 'list_pages_to_verify',
        scope: 'read',
        description:
          'Pages whose verification has run out, or runs out within some days: the ones somebody should read again and confirm. Oldest first.',
        schema: z.object({
          spaceId: z.string().uuid().optional(),
          withinDays: z.number().int().min(0).max(90).optional().describe('Also the ones that run out within this many days'),
        }),
        execute: guard('list_pages_to_verify', async (args: { spaceId?: string; withinDays?: number }) =>
          this.listPagesToVerify(ctx, args),
        ),
      },
    ];

    if (!ctx.readOnly) {
      defs.push(
        {
          name: 'create_page',
          scope: 'write',
          description:
            'Create a page with Markdown content in a space, optionally under a parent page. Only when the user asked for a page to be created; tell them the url afterwards.',
          schema: z.object({
            spaceId: z.string().uuid(),
            title: z.string().min(1).max(500),
            content: z.string().max(100_000).describe('The page body as Markdown'),
            parentPageId: z.string().uuid().optional(),
          }),
          execute: guard(
            'create_page',
            async (args: { spaceId: string; title: string; content: string; parentPageId?: string }) =>
              this.createPage(ctx, args),
          ),
        },
        {
          name: 'suggest_page_edit',
          scope: 'write',
          description:
            'Propose a change to an existing page as a suggestion: text to append, to prepend, or a new version of the whole body, in Markdown. ' +
            'The page stays as it is until someone who can edit it accepts the suggestion on the page. ' +
            (ctx.suggestEdits
              ? 'This is the only way to change an existing page here: use it whenever the user asks for an edit, then tell them it waits for review and give them reviewUrl.'
              : 'Use it when the user asks for a proposal or a review rather than a direct edit; give them reviewUrl.'),
          schema: z.object({
            pageId: z.string().min(1).max(100).describe('The page id or slugId'),
            content: z.string().min(1).max(100_000).describe('Markdown to add, or the whole new body'),
            operation: z.enum(['append', 'prepend', 'replace']).default('append'),
            note: z.string().max(500).optional().describe('One or two sentences on what changes and why, for the reviewer'),
          }),
          execute: guard(
            'suggest_page_edit',
            async (args: { pageId: string; content: string; operation: SuggestionOperation; note?: string }) =>
              this.suggestEdit(ctx, args),
          ),
        },
      );
      if (!ctx.suggestEdits) {
        defs.push({
          name: 'update_page',
          scope: 'write',
          description:
            'Change the content of an existing page: append to it, prepend, or replace all of it with new Markdown. Only when the user asked for the page to be edited.',
          schema: z.object({
            pageId: z.string().min(1).max(100).describe('The page id or slugId'),
            content: z.string().max(100_000).describe('Markdown to add or the new body'),
            operation: z.enum(['append', 'prepend', 'replace']).default('append'),
          }),
          execute: guard(
            'update_page',
            async (args: { pageId: string; content: string; operation: 'append' | 'prepend' | 'replace' }) =>
              this.updatePage(ctx, args),
          ),
        });
      }
    }
    defs.push(...this.baseTools.definitions(ctx, guard));
    return defs;
  }

  async build(ctx: ToolContext): Promise<Record<string, any>> {
    const { tool } = await import('ai');
    const tools: Record<string, any> = {};
    for (const def of await this.definitions(ctx)) {
      if (def.name === 'get_current_user' || def.name === 'list_pages') continue;
      tools[def.name] = tool({ description: def.description, inputSchema: def.schema, execute: def.execute });
    }
    return tools;
  }

  // For other AI features (research) that look things up as the user.
  async searchAs(ctx: ToolContext, query: string, spaceId?: string) {
    return this.searchPages(ctx, query, spaceId);
  }

  async readAs(ctx: ToolContext, idOrSlug: string) {
    return this.getPage(ctx, idOrSlug);
  }

  // The spaces a tool may look at: the person's, or the one an agent is kept to.
  private async spacesOf(ctx: ToolContext, spaceId?: string): Promise<string[]> {
    const member = await this.spaceMemberRepo.getUserSpaceIds(ctx.user.id, { excludeArchived: true } as any);
    const within = ctx.spaceId ? member.filter((id) => id === ctx.spaceId) : member;
    return spaceId ? within.filter((id) => id === spaceId) : within;
  }

  private async listChangedPages(ctx: ToolContext, args: { since?: string; spaceId?: string; limit?: number }) {
    let since = ctx.since ?? new Date(Date.now() - 7 * 86_400_000);
    if (args.since) {
      const asked = new Date(args.since);
      if (Number.isNaN(asked.getTime())) return { error: 'since is not a date' };
      since = asked;
    }
    const spaces = await this.spacesOf(ctx, args.spaceId);
    if (!spaces.length) return args.spaceId ? { error: 'You do not have access to that space' } : { since, pages: [] };
    const limit = args.limit ?? 50;
    const rows = await this.db
      .selectFrom('pages')
      .innerJoin('spaces', 'spaces.id', 'pages.spaceId')
      .leftJoin('users', 'users.id', 'pages.lastUpdatedById')
      .select(['pages.id', 'pages.title', 'pages.slugId', 'pages.spaceId', 'pages.createdAt', 'pages.updatedAt', 'pages.isBase', 'spaces.slug as spaceSlug', 'spaces.name as spaceName', 'users.name as editor'])
      .where('pages.workspaceId', '=', ctx.workspace.id)
      .where('pages.spaceId', 'in', spaces)
      .where('pages.deletedAt', 'is', null)
      .where('pages.updatedAt', '>=', since)
      .orderBy('pages.updatedAt', 'desc')
      // some may be kept from this person: ask for more than is shown
      .limit(limit * 2)
      .execute();
    const visible = await this.visibleIds(ctx, rows);
    return {
      since,
      pages: rows
        .filter((r) => visible.has(r.id))
        .slice(0, limit)
        .map((r) => ({
          id: r.id,
          title: r.title || 'Untitled',
          space: r.spaceName,
          url: pageUrl(r.spaceSlug, r.slugId),
          kind: r.isBase ? 'base' : 'page',
          created: new Date(r.createdAt as any) >= since,
          updatedAt: r.updatedAt,
          lastEditedBy: r.editor ?? null,
        })),
    };
  }

  private async listPagesToVerify(ctx: ToolContext, args: { spaceId?: string; withinDays?: number }) {
    const spaces = await this.spacesOf(ctx, args.spaceId);
    if (!spaces.length) return args.spaceId ? { error: 'You do not have access to that space' } : { pages: [] };
    const now = new Date();
    const horizon = new Date(now.getTime() + (args.withinDays ?? 0) * 86_400_000);
    const rows = await this.db
      .selectFrom('pageVerifications')
      .innerJoin('pages', 'pages.id', 'pageVerifications.pageId')
      .innerJoin('spaces', 'spaces.id', 'pages.spaceId')
      .leftJoin('users', 'users.id', 'pageVerifications.verifiedById')
      .select(['pages.id', 'pages.title', 'pages.slugId', 'pages.spaceId', 'pageVerifications.expiresAt', 'pageVerifications.verifiedAt', 'spaces.slug as spaceSlug', 'spaces.name as spaceName', 'users.name as verifier'])
      .where('pageVerifications.workspaceId', '=', ctx.workspace.id)
      .where('pages.spaceId', 'in', spaces)
      .where('pages.deletedAt', 'is', null)
      .where('pageVerifications.expiresAt', 'is not', null)
      .where('pageVerifications.expiresAt', '<=', horizon)
      .orderBy('pageVerifications.expiresAt', 'asc')
      .limit(200)
      .execute();
    const visible = await this.visibleIds(ctx, rows);
    return {
      pages: rows
        .filter((r) => visible.has(r.id))
        .slice(0, 100)
        .map((r) => ({
          id: r.id,
          title: r.title || 'Untitled',
          space: r.spaceName,
          url: pageUrl(r.spaceSlug, r.slugId),
          expiresAt: r.expiresAt,
          expired: new Date(r.expiresAt as any) <= now,
          lastVerifiedAt: r.verifiedAt,
          lastVerifiedBy: r.verifier ?? null,
        })),
    };
  }

  // Of these pages, the ones no page restriction keeps from the person.
  private async visibleIds(ctx: ToolContext, rows: Array<{ id: string; spaceId: string }>): Promise<Set<string>> {
    const bySpace = new Map<string, string[]>();
    for (const row of rows) bySpace.set(row.spaceId, [...(bySpace.get(row.spaceId) ?? []), row.id]);
    const visible = new Set<string>();
    for (const [spaceId, pageIds] of bySpace) {
      for (const id of await this.pagePermissionRepo.filterAccessiblePageIds({ pageIds, userId: ctx.user.id, spaceId })) visible.add(id);
    }
    return visible;
  }

  private async listPages(ctx: ToolContext, spaceId: string, limit: number) {
    const member = await this.spacesOf(ctx);
    if (!member.includes(spaceId)) return { error: 'You do not have access to that space' };
    const rows = await this.db
      .selectFrom('pages')
      .innerJoin('spaces', 'spaces.id', 'pages.spaceId')
      .select(['pages.id', 'pages.title', 'pages.slugId', 'pages.parentPageId', 'pages.updatedAt', 'spaces.slug as spaceSlug'])
      .where('pages.spaceId', '=', spaceId)
      .where('pages.workspaceId', '=', ctx.workspace.id)
      .where('pages.deletedAt', 'is', null)
      .orderBy('pages.updatedAt', 'desc')
      .limit(limit)
      .execute();
    const accessible = new Set(
      await this.pagePermissionRepo.filterAccessiblePageIds({
        pageIds: rows.map((r) => r.id),
        userId: ctx.user.id,
        spaceId,
      }),
    );
    return {
      pages: rows.filter((r) => accessible.has(r.id)).map((r) => ({
        id: r.id,
        title: r.title || 'Untitled',
        parentPageId: r.parentPageId,
        updatedAt: r.updatedAt,
        url: pageUrl(r.spaceSlug, r.slugId),
      })),
    };
  }

  // ---- reads --------------------------------------------------------------

  private async listSpaces(ctx: ToolContext) {
    const spaces = await this.db
      .selectFrom('spaces')
      .select(['id', 'name', 'slug', 'description', 'archivedAt'])
      .where('workspaceId', '=', ctx.workspace.id)
      .where('id', 'in', this.spaceMemberRepo.getUserSpaceIdsQuery(ctx.user.id, { excludeArchived: true }))
      .orderBy('name', 'asc')
      .limit(100)
      .execute();
    return {
      spaces: spaces
        .filter((s) => !ctx.spaceId || s.id === ctx.spaceId)
        .map((s) => ({ id: s.id, name: s.name, slug: s.slug, description: s.description ?? '' })),
    };
  }

  private async searchPages(ctx: ToolContext, query: string, askedSpaceId?: string) {
    if (ctx.spaceId && askedSpaceId && askedSpaceId !== ctx.spaceId) return { error: 'This agent is kept to one space' };
    const spaceId = ctx.spaceId ?? askedSpaceId;
    const semantic =
      this.embeddings.available &&
      (await this.embeddings.isEnabled(ctx.workspace.id)) &&
      Boolean(await this.settings.embeddingChoice(ctx.workspace.id));

    if (semantic) {
      const sources = await this.embeddings.search(ctx.workspace.id, ctx.user.id, query, { spaceId });
      const seen = new Set<string>();
      const results = [];
      for (const s of sources) {
        if (seen.has(s.pageId)) continue;
        seen.add(s.pageId);
        results.push({
          pageId: s.pageId,
          title: s.title,
          space: s.spaceName,
          url: pageUrl(s.spaceSlug, s.slugId),
          excerpt: s.excerpt.slice(0, 600),
        });
      }
      return { method: 'semantic', results };
    }

    const { items } = await this.searchService.searchPage(
      { query, spaceId, limit: 8 } as any,
      { userId: ctx.user.id, workspaceId: ctx.workspace.id },
    );
    return {
      method: 'keyword',
      results: (items as any[]).map((item) => ({
        pageId: item.id,
        title: item.title || 'Untitled',
        space: item.space?.name ?? null,
        url: pageUrl(item.space?.slug ?? null, item.slugId),
        excerpt: stripTags(item.highlight ?? '').slice(0, 600),
      })),
    };
  }

  private async getPage(ctx: ToolContext, idOrSlug: string) {
    const page = await this.findReadablePage(ctx, idOrSlug);
    const ref = await this.refOf(page);
    let markdown = '';
    if (page.content) {
      try {
        markdown = jsonToMarkdown(page.content as any);
      } catch (err: any) {
        this.logger.debug(`page ${page.id} to markdown failed: ${err?.message}`);
        markdown = page.textContent ?? '';
      }
    }
    const truncated = markdown.length > MAX_TOOL_PAGE_CHARS;
    return {
      ...ref,
      updatedAt: page.updatedAt,
      content: truncated ? `${markdown.slice(0, MAX_TOOL_PAGE_CHARS)}\n\n[truncated]` : markdown,
      truncated,
    };
  }

  // ---- writes -------------------------------------------------------------

  private async createPage(
    ctx: ToolContext,
    args: { spaceId: string; title: string; content: string; parentPageId?: string },
  ) {
    if (ctx.spaceId && args.spaceId !== ctx.spaceId) return { error: 'This agent is kept to one space' };
    if (args.parentPageId) {
      const parent = await this.pageRepo.findById(args.parentPageId);
      if (!parent || parent.deletedAt || parent.spaceId !== args.spaceId) {
        return { error: 'Parent page not found in that space' };
      }
      await this.pageAccess.validateCanEdit(parent, ctx.user);
    } else {
      const ability = await this.spaceAbility.createForUser(ctx.user, args.spaceId);
      if (ability.cannot(SpaceCaslAction.Create, SpaceCaslSubject.Page)) {
        return { error: 'You cannot create pages in that space' };
      }
    }
    const page = await this.pageService.create(ctx.user.id, ctx.workspace.id, {
      spaceId: args.spaceId,
      title: args.title,
      content: args.content,
      format: 'markdown',
      parentPageId: args.parentPageId,
    } as any);
    this.audit.log({
      event: AuditEvent.PAGE_CREATED,
      resourceType: AuditResource.PAGE,
      resourceId: page.id,
      spaceId: page.spaceId,
      changes: { after: { title: page.title, spaceId: page.spaceId, via: 'ai-chat' } },
    });
    return { created: true, ...(await this.refOf(page)) };
  }

  private async updatePage(
    ctx: ToolContext,
    args: { pageId: string; content: string; operation: 'append' | 'prepend' | 'replace' },
  ) {
    const page = await this.findReadablePage(ctx, args.pageId);
    await this.pageAccess.validateCanEdit(page, ctx.user);
    const updated = await this.pageService.update(
      page,
      { pageId: page.id, content: args.content, format: 'markdown', operation: args.operation } as any,
      ctx.user,
    );
    return { updated: true, operation: args.operation, ...(await this.refOf(updated)) };
  }

  // The change is filed for review; nothing on the page moves.
  private async suggestEdit(
    ctx: ToolContext,
    args: { pageId: string; content: string; operation: SuggestionOperation; note?: string },
  ) {
    const page = await this.findReadablePage(ctx, args.pageId);
    if (page.isBase) return { error: 'A base takes no suggestions; change its rows instead' };
    const piece = await this.pageService.parseProsemirrorContent(args.content, 'markdown');
    const suggestion = await this.suggestions.create(
      ctx.user,
      ctx.workspace.id,
      { pageId: page.id, content: piece, note: args.note },
      { origin: ctx.origin ?? 'chat', label: ctx.originLabel ?? null, operation: args.operation ?? 'append' },
    );
    const ref = await this.refOf(page);
    return {
      proposed: true,
      suggestionId: suggestion.id,
      operation: suggestion.operation,
      status: 'waiting for review: the page is unchanged until someone who can edit it accepts the suggestion',
      reviewUrl: `${ref.url}?suggestion=${suggestion.id}`,
      ...ref,
    };
  }

  // ---- helpers ------------------------------------------------------------

  private async findReadablePage(ctx: ToolContext, idOrSlug: string): Promise<Page> {
    let pageId = idOrSlug.trim();
    if (!isValidUUID(pageId)) {
      const bySlug = await this.db
        .selectFrom('pages')
        .select('id')
        .where('slugId', '=', pageId)
        .where('workspaceId', '=', ctx.workspace.id)
        .executeTakeFirst();
      if (!bySlug) throw new Error('Page not found');
      pageId = bySlug.id;
    }
    const page = await this.pageRepo.findById(pageId, { includeContent: true, includeTextContent: true });
    if (!page || page.deletedAt || page.workspaceId !== ctx.workspace.id) {
      throw new Error('Page not found');
    }
    if (ctx.spaceId && page.spaceId !== ctx.spaceId) throw new Error('Page not found');
    await this.pageAccess.validateCanView(page, ctx.user);
    return page;
  }

  private async refOf(page: Pick<Page, 'id' | 'title' | 'slugId' | 'spaceId'>): Promise<PageRef> {
    const space = await this.db
      .selectFrom('spaces')
      .select(['slug', 'name'])
      .where('id', '=', page.spaceId)
      .executeTakeFirst();
    return {
      id: page.id,
      title: page.title || 'Untitled',
      slugId: page.slugId,
      spaceSlug: space?.slug ?? null,
      url: pageUrl(space?.slug ?? null, page.slugId),
    };
  }
}

export function pageUrl(spaceSlug: string | null, slugId: string): string {
  return spaceSlug ? `/s/${spaceSlug}/p/${slugId}` : `/p/${slugId}`;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function friendly(err: any): string {
  const status = err?.status ?? err?.statusCode;
  if (status === 403) return 'You do not have access to that';
  if (status === 404) return 'Not found';
  const message: string = err?.message ?? 'The tool failed';
  return message.split('\n')[0].slice(0, 200);
}
