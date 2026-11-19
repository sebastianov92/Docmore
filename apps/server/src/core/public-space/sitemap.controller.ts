import { Controller, Get, Header, Req } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PublicSpaceRepo } from '@docmost/db/repos/public-space/public-space.repo';
import { Workspace } from '@docmost/db/types/entity.types';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { SkipTransform } from '../../common/decorators/skip-transform.decorator';
import { PublicSpaceService } from './public-space.service';

// sitemap.xml: every public page crawlers may index — published spaces
// with indexing on, and public links with indexing on (not password
// protected, not expired).
@Controller('sitemap.xml')
export class SitemapController {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly workspaceRepo: WorkspaceRepo,
    private readonly pageRepo: PageRepo,
    private readonly publicSpaceRepo: PublicSpaceRepo,
    private readonly publicSpaceService: PublicSpaceService,
    private readonly environmentService: EnvironmentService,
  ) {}

  @SkipTransform()
  @Header('Content-Type', 'application/xml; charset=utf-8')
  @Header('Cache-Control', 'public, max-age=600')
  @Get()
  async sitemap(@Req() req: FastifyRequest): Promise<string> {
    const workspace = await this.resolveWorkspace(req);
    const base = this.environmentService.getAppUrl().replace(/\/$/, '');
    const urls: Array<{ loc: string; lastmod?: Date | string | null }> = [];
    if (workspace) {
      await this.collectPublicSpaces(workspace, base, urls);
      await this.collectShares(workspace, base, urls);
    }
    const body = urls
      .slice(0, 50000)
      .map(
        (u) =>
          `  <url><loc>${escapeXml(u.loc)}</loc>${
            u.lastmod ? `<lastmod>${toDate(u.lastmod)}</lastmod>` : ''
          }</url>`,
      )
      .join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
  }

  private async collectPublicSpaces(
    workspace: Workspace,
    base: string,
    urls: Array<{ loc: string; lastmod?: Date | string | null }>,
  ) {
    try {
      await this.publicSpaceService.getPublicSpaceDirectory(workspace);
      urls.push({ loc: `${base}/docs` });
    } catch {
      // directory off: no hub url
    }
    let rows: any[] = [];
    try {
      rows = await this.publicSpaceRepo.findEnabledWithSpaceByWorkspaceId(
        workspace.id,
      );
    } catch {
      return;
    }
    for (const row of rows) {
      if (!row.searchIndexing || !row.slug) continue;
      urls.push({ loc: `${base}/docs/${row.slug}` });
      const spaceId = row.spaceId ?? row.space_id;
      if (!spaceId) continue;
      const pages = await this.pageRepo.getSpacePagesExcludingRestricted(spaceId);
      for (const page of pages as any[]) {
        urls.push({
          loc: `${base}/docs/${row.slug}/${pageSlug(page.title, page.slugId)}`,
          lastmod: page.updatedAt,
        });
      }
    }
  }

  private async collectShares(
    workspace: Workspace,
    base: string,
    urls: Array<{ loc: string; lastmod?: Date | string | null }>,
  ) {
    const shares = await this.db
      .selectFrom('shares')
      .innerJoin('pages', 'pages.id', 'shares.pageId')
      .select([
        'shares.key',
        'shares.pageId',
        'shares.includeSubPages',
        'shares.expiresAt',
        'shares.passwordHash',
        'pages.title',
        'pages.slugId',
        'pages.updatedAt',
      ])
      .where('shares.workspaceId', '=', workspace.id)
      .where('shares.searchIndexing', '=', true)
      .where('shares.deletedAt', 'is', null)
      .where('pages.deletedAt', 'is', null)
      .execute();
    for (const share of shares) {
      if (share.passwordHash) continue;
      if (share.expiresAt && new Date(share.expiresAt).getTime() < Date.now()) continue;
      urls.push({
        loc: `${base}/share/${share.key}/p/${pageSlug(share.title, share.slugId)}`,
        lastmod: share.updatedAt,
      });
      if (!share.includeSubPages) continue;
      const tree = await this.pageRepo.getPageAndDescendantsExcludingRestricted(
        share.pageId,
        { includeContent: false },
      );
      for (const page of tree as any[]) {
        if (page.id === share.pageId) continue;
        urls.push({
          loc: `${base}/share/${share.key}/p/${pageSlug(page.title, page.slugId)}`,
          lastmod: page.updatedAt,
        });
      }
    }
  }

  private async resolveWorkspace(req: FastifyRequest): Promise<Workspace> {
    if (this.environmentService.isSelfHosted()) {
      return this.workspaceRepo.findFirst();
    }
    const header = req.raw.headers.host ?? '';
    const subdomain = header.split('.')[0];
    return this.workspaceRepo.findByHostname(subdomain);
  }
}

// Same shape the client builds: "<slugified title>-<slugId>".
export function pageSlug(title: string | null | undefined, slugId: string): string {
  const slug = (title ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug ? `${slug}-${slugId}` : slugId;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function toDate(value: Date | string): string {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}
