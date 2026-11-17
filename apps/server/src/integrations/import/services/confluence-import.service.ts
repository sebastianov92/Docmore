import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import * as path from 'path';
import { promises as fs } from 'fs';
import { load } from 'cheerio';
import { v7 } from 'uuid';
import { generateJitteredKeyBetween } from 'fractional-indexing-jittered';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { FileTask } from '@docmost/db/types/entity.types';
import { generateSlugId } from '../../../common/helpers';
import { PageService } from '../../../core/page/services/page.service';
import { ImportPageNode } from '../dto/file-task-dto';
import { buildAttachmentCandidates, collectMarkdownAndHtmlFiles } from '../utils/import.utils';
import {
  breadcrumbParent,
  confluenceBodyHtml,
  confluenceTitle,
  isIndexFile,
  pageAttachments,
  parseIndexTree,
  titleFromFileName,
} from '../utils/confluence-formatter';
import { FileImportTaskService } from './file-import-task.service';

// Imports the HTML export of a Confluence space. The page tree comes from
// index.html (or each page's breadcrumbs), titles from the page header, and
// the body goes through the Confluence formatter before the shared page
// importer stores pages, attachments and links.
@Injectable()
export class ConfluenceImportService {
  private readonly logger = new Logger(ConfluenceImportService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly pageService: PageService,
    // The task service resolves this one lazily and this one needs its page
    // tree importer: forwardRef breaks the import cycle at decoration time.
    @Inject(forwardRef(() => FileImportTaskService))
    private readonly fileImportTaskService: FileImportTaskService,
  ) {}

  async processConfluenceImport(opts: { extractDir: string; fileTask: FileTask }): Promise<void> {
    const { extractDir, fileTask } = opts;
    const htmlFiles = (await collectMarkdownAndHtmlFiles(extractDir)).filter(
      (abs) => path.extname(abs).toLowerCase() === '.html',
    );
    const root = await this.findExportRoot(extractDir, htmlFiles);
    const indexPath = path.join(root, 'index.html');
    let tree = new Map<string, { parentFile: string | null; order: number }>();
    try {
      tree = parseIndexTree(await fs.readFile(indexPath, 'utf-8'));
    } catch {
      this.logger.debug('Confluence export without index.html; using breadcrumbs for the tree');
    }

    // Pages live next to index.html; anything deeper is styles or assets.
    const pageFiles = htmlFiles.filter(
      (abs) => path.dirname(abs) === root && !isIndexFile(abs),
    );
    if (pageFiles.length === 0) {
      throw new Error('No Confluence pages found in the archive');
    }

    const pagesMap = new Map<string, ImportPageNode>();
    const byFileName = new Map<string, ImportPageNode>();
    const parentFileOf = new Map<string, string | null>();
    const orderOf = new Map<string, number>();

    for (const abs of pageFiles) {
      const relPath = path.relative(extractDir, abs).split(path.sep).join('/');
      const fileName = path.basename(abs);
      const html = await fs.readFile(abs, 'utf-8');
      const $ = load(html);
      const node: ImportPageNode = {
        id: v7(),
        slugId: generateSlugId(),
        name: confluenceTitle($, titleFromFileName(fileName)),
        content: '',
        parentPageId: null,
        fileExtension: '.html',
        filePath: relPath,
      };
      pagesMap.set(relPath, node);
      byFileName.set(fileName, node);
      const fromIndex = tree.get(fileName);
      parentFileOf.set(fileName, fromIndex ? fromIndex.parentFile : breadcrumbParent($));
      orderOf.set(fileName, fromIndex?.order ?? Number.MAX_SAFE_INTEGER);
    }

    for (const [fileName, node] of byFileName) {
      const parentFile = parentFileOf.get(fileName);
      const parent = parentFile ? byFileName.get(parentFile) : undefined;
      if (parent && parent !== node) node.parentPageId = parent.id;
    }

    // Positions: index.html order when known, title order otherwise.
    const siblings = new Map<string | null, ImportPageNode[]>();
    for (const node of pagesMap.values()) {
      const group = siblings.get(node.parentPageId) ?? [];
      group.push(node);
      siblings.set(node.parentPageId, group);
    }
    const sortGroup = (group: ImportPageNode[]) =>
      group.sort((a, b) => {
        const oa = orderOf.get(path.basename(a.filePath)) ?? Number.MAX_SAFE_INTEGER;
        const ob = orderOf.get(path.basename(b.filePath)) ?? Number.MAX_SAFE_INTEGER;
        return oa !== ob ? oa - ob : a.name.localeCompare(b.name);
      });

    const roots = siblings.get(null) ?? [];
    sortGroup(roots);
    let prev: string | null = null;
    const first = await this.pageService.nextPagePosition(fileTask.spaceId);
    roots.forEach((node, index) => {
      node.position = index === 0 ? first : generateJitteredKeyBetween(prev, null);
      prev = node.position;
    });
    for (const [parentId, group] of siblings) {
      if (parentId === null) continue;
      sortGroup(group);
      let last: string | null = null;
      for (const node of group) {
        node.position = generateJitteredKeyBetween(last, null);
        last = node.position;
      }
    }

    const space = await this.db
      .selectFrom('spaces')
      .select('slug')
      .where('id', '=', fileTask.spaceId)
      .executeTakeFirst();
    const attachmentCandidates = await buildAttachmentCandidates(extractDir);

    this.logger.log(
      `Importing ${pagesMap.size} Confluence page(s) (${tree.size ? 'tree from index.html' : 'tree from breadcrumbs'})`,
    );

    await this.fileImportTaskService.importPageTree({
      extractDir,
      fileTask,
      pagesMap,
      attachmentCandidates,
      spaceSlug: space?.slug,
      prepareHtml: async (_page, html) => {
        const $ = load(html);
        return { html: confluenceBodyHtml(html), attachments: pageAttachments($) };
      },
    });
  }

  // The export may be zipped with or without its top folder.
  private async findExportRoot(extractDir: string, htmlFiles: string[]): Promise<string> {
    const withIndex = htmlFiles.find((abs) => isIndexFile(abs));
    if (withIndex) return path.dirname(withIndex);
    const counts = new Map<string, number>();
    for (const abs of htmlFiles) {
      const dir = path.dirname(abs);
      counts.set(dir, (counts.get(dir) ?? 0) + 1);
    }
    let best = extractDir;
    let bestCount = -1;
    for (const [dir, count] of counts) {
      if (count > bestCount) {
        best = dir;
        bestCount = count;
      }
    }
    return best;
  }
}
