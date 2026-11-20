import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PageService } from '../page/services/page.service';
import { SpaceRepo } from '@docmost/db/repos/space/space.repo';
import { User } from '@docmost/db/types/entity.types';
import { assertPublicUrl, extractPageMeta, fetchPublicHtml } from '../../common/helpers/public-url';
import { ClipDto } from './clipper.dto';

// Saves a web page (or a selection of it) as a new page of a space.
@Injectable()
export class ClipperService {
  constructor(
    private readonly pageService: PageService,
    private readonly spaceRepo: SpaceRepo,
  ) {}

  async clip(dto: ClipDto, user: User, workspaceId: string) {
    const space = await this.spaceRepo.findById(dto.spaceId, workspaceId);
    if (!space) throw new NotFoundException('Space not found');
    const url = assertPublicUrl(dto.url).toString();
    let title = dto.title?.trim();
    let html = dto.html?.trim();
    if (!html) {
      let fetched: Awaited<ReturnType<typeof fetchPublicHtml>>;
      try {
        fetched = await fetchPublicHtml(url, { timeoutMs: 10_000, maxBytes: 2_000_000 });
      } catch (err: any) {
        if (err instanceof BadRequestException) throw err;
        throw new BadRequestException(`Could not fetch that page: ${String(err?.cause?.message ?? err?.message ?? 'network error').slice(0, 200)}`);
      }
      if (!/text\/html|application\/xhtml/i.test(fetched.contentType) || fetched.status >= 400) {
        throw new BadRequestException('That address does not serve a web page');
      }
      const meta = extractPageMeta(fetched.body, fetched.url);
      title = title || meta.title;
      html = mainContent(fetched.body);
    }
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    const content = `<p><em>Clipped from <a href="${escapeAttr(url)}">${escapeText(hostname)}</a></em></p>` + cleanHtml(html);
    const page = await this.pageService.create(user.id, workspaceId, {
      spaceId: dto.spaceId,
      parentPageId: dto.parentPageId,
      title: (title || hostname).slice(0, 500),
      content,
      format: 'html',
    } as any);
    return { id: page.id, slugId: page.slugId, title: page.title, spaceId: space.id, spaceSlug: space.slug };
  }
}

// <article>, else <main>, else the body.
function mainContent(html: string): string {
  const pick = (tag: string) => {
    const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(html);
    return m ? m[1] : null;
  };
  return pick('article') ?? pick('main') ?? pick('body') ?? html;
}

// Drops what the editor cannot keep or should not run.
function cleanHtml(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|iframe|object|embed|svg|canvas|form|nav|header|footer|aside|button|input|select|textarea)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(script|style|iframe|link|meta)[^>]*\/?>/gi, '')
    .replace(/\s(href|src)=("\s*(?:javascript|data|vbscript):[^"]*"|'\s*(?:javascript|data|vbscript):[^']*')/gi, '')
    .replace(/\son\w+=("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(class|id|style)=("[^"]*"|'[^']*')/gi, '')
    .replace(/javascript:/gi, '');
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
