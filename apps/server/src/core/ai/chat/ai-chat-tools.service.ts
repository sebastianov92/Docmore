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
        },
      );
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

  private async listPages(ctx: ToolContext, spaceId: string, limit: number) {
    const member = await this.spaceMemberRepo.getUserSpaceIds(ctx.user.id);
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
      spaces: spaces.map((s) => ({ id: s.id, name: s.name, slug: s.slug, description: s.description ?? '' })),
    };
  }

  private async searchPages(ctx: ToolContext, query: string, spaceId?: string) {
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
