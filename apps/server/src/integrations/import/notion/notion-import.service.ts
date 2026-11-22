import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { InjectKysely } from 'nestjs-kysely';
import { v7 as uuid7 } from 'uuid';
import * as path from 'path';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { QueueJob, QueueName } from '../../queue/constants';
import { EncryptionPurpose, EncryptionService } from '../../encryption/encryption.service';
import { StorageService } from '../../storage/storage.service';
import SpaceAbilityFactory from '../../../core/casl/abilities/space-ability.factory';
import { SpaceCaslAction, SpaceCaslSubject } from '../../../core/casl/interfaces/space-ability.type';
import { PageService } from '../../../core/page/services/page.service';
import { PageAccessService } from '../../../core/page/page-access/page-access.service';
import { BaseService } from '../../../core/base/services/base.service';
import { BasePropertyService } from '../../../core/base/services/base-property.service';
import { BaseRowService } from '../../../core/base/services/base-row.service';
import { BaseViewService } from '../../../core/base/services/base-view.service';
import { AttachmentType } from '../../../core/attachment/attachment.constants';
import { getAttachmentFolderPath } from '../../../core/attachment/attachment.utils';
import { getMimeType } from '../../../common/helpers/file.helper';
import { htmlToJson } from '../../../collaboration/collaboration.util';
import { NotionClient, NotionError } from './notion-client';
import { blocksToHtml, NotionBlock, plainText } from './notion-html';
import { cellOf, ImportNote, MappedProperty, mapSchema, mapView } from './notion-schema';

export interface NotionRoot {
  id: string;
  kind: 'page' | 'database';
  title: string;
  icon: string | null;
}

export interface NotionImportView {
  id: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  progress: { step: string; pages: number; bases: number; rows: number; files: number } | null;
  report: {
    pages: number;
    bases: number;
    rows: number;
    files: number;
    views: number;
    roots: Array<{ title: string; url: string }>;
    skipped: Array<{ type: string; count: number }>;
    notes: ImportNote[];
  } | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

type Row = { id: string; title: string; properties: Record<string, any>; blocks: NotionBlock[]; rowId?: string; pageId?: string };
type Source = { id: string; name: string; schema: Record<string, any>; rows: Row[]; views: any[]; node?: Node; mapped?: MappedProperty[]; propertyIds?: Map<string, string> };
type Node = {
  id: string;
  kind: 'page' | 'database';
  title: string;
  icon: string | null;
  blocks: NotionBlock[];
  children: Node[];
  sources: Source[];
  // one table of a database with several: which one this base holds
  source?: Source;
  pageId?: string;
  url?: string;
  // picked on its own, then found inside another picked page: it went there
  adopted?: boolean;
};

// what one import brings over at most
const MAX_PAGES = 1_500;
const MAX_DEPTH = 15;
const MAX_ROWS = 2_000;
const MAX_ROW_PAGES = 400;
// each row is asked for its text with one request: only so many per import
const MAX_ROW_SCANS = 1_000;
const MAX_VIEWS = 12;
const MAX_FILES = 300;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_ROOTS_LISTED = 300;
const MAX_NOTES = 60;

const norm = (id: unknown) => String(id ?? '').replace(/-/g, '').toLowerCase();

// Notion through its API, with the secret of a connection the person made
// there: the pages they shared with it come over with their sub-pages, and
// each database becomes a base with its columns, rows and views.
@Injectable()
export class NotionImportService {
  private readonly logger = new Logger(NotionImportService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly userRepo: UserRepo,
    private readonly pageRepo: PageRepo,
    private readonly pageService: PageService,
    private readonly pageAccess: PageAccessService,
    private readonly baseService: BaseService,
    private readonly properties: BasePropertyService,
    private readonly rows: BaseRowService,
    private readonly views: BaseViewService,
    private readonly spaceAbility: SpaceAbilityFactory,
    private readonly storage: StorageService,
    private readonly encryption: EncryptionService,
    @InjectQueue(QueueName.FILE_TASK_QUEUE) private readonly queue: Queue,
  ) {}

  // What the connection can reach, top level only: the pages and databases
  // that were shared with it, not what hangs from them. `seen` says how
  // much Notion's search knows of at all: a page shared a moment ago can
  // take a while to show up there.
  async roots(token: string): Promise<{ items: NotionRoot[]; seen: { pages: number; databases: number } }> {
    const client = new NotionClient(readToken(token));
    let pages: any[];
    let sources: any[];
    try {
      pages = await client.search('page', 2_000);
      sources = await client.search('data_source', 500);
    } catch (err: any) {
      // what Notion said, in words the person can act on
      if (err instanceof NotionError) throw new BadRequestException(err.message);
      throw err;
    }
    const reachable = new Set<string>(pages.map((p) => norm(p.id)));
    const databases = new Map<string, any>();
    for (const source of sources) {
      const databaseId = norm(source?.parent?.database_id ?? source?.database_parent?.database_id ?? source?.id);
      if (!databases.has(databaseId)) databases.set(databaseId, source);
    }
    for (const id of databases.keys()) reachable.add(id);

    // Is this the top of what was shared? A page inside a block (a toggle,
    // a column) is followed up to the page that holds it.
    let lookups = 0;
    const top = async (parent: any): Promise<boolean> => {
      for (let hop = 0; parent?.type === 'block_id' && hop < 6; hop++) {
        if (lookups++ > 60) return true;
        try {
          parent = (await client.block(String(parent.block_id)))?.parent;
        } catch {
          // the block that holds it cannot be read: nothing above it comes along
          return true;
        }
      }
      if (!parent || parent.type === 'workspace') return true;
      if (parent.type === 'page_id') return !reachable.has(norm(parent.page_id));
      // a row of a database comes with its database
      if (parent.type === 'database_id' || parent.type === 'data_source_id') return false;
      return true;
    };
    const out: NotionRoot[] = [];
    for (const page of pages) {
      if (page?.in_trash || !(await top(page?.parent))) continue;
      out.push({ id: norm(page.id), kind: 'page', title: pageTitle(page), icon: emojiOf(page?.icon) });
    }
    for (const [databaseId, source] of databases) {
      if (source?.in_trash || !(await top(source?.database_parent))) continue;
      out.push({ id: databaseId, kind: 'database', title: plainText(source?.title).trim() || 'Untitled', icon: emojiOf(source?.icon) });
    }
    return {
      items: out.sort((a, b) => a.title.localeCompare(b.title)).slice(0, MAX_ROOTS_LISTED),
      seen: { pages: pages.length, databases: databases.size },
    };
  }

  // One page or database by its link, asked for directly: it does not
  // depend on Notion's search, which lags behind what was just shared.
  async resolve(token: string, link: string): Promise<NotionRoot> {
    const client = new NotionClient(readToken(token));
    const id = idFromLink(link);
    if (!id) throw new BadRequestException('That does not look like the link of a Notion page');
    let reason = 'Notion did not find it: the page has to be shared with the connection.';
    try {
      const page = await client.page(id);
      if (page?.in_trash) throw new BadRequestException('That page is in the trash in Notion');
      return { id, kind: 'page', title: pageTitle(page), icon: emojiOf(page?.icon) };
    } catch (err: any) {
      if (err instanceof BadRequestException) throw err;
      if (!(err instanceof NotionError)) throw err;
      // a wrong secret or no permission is the same whatever is asked for
      if (err.status === 401 || err.status === 403 || err.status === 429 || err.status === 0) throw new BadRequestException(err.message);
      reason = err.message;
    }
    try {
      const database = await client.database(id);
      return { id, kind: 'database', title: plainText(database?.title).trim() || 'Untitled', icon: emojiOf(database?.icon) };
    } catch (err: any) {
      if (!(err instanceof NotionError)) throw err;
    }
    try {
      // the link of one table of a database
      const source = await client.dataSource(id);
      const databaseId = norm(source?.parent?.database_id);
      if (databaseId) return { id: databaseId, kind: 'database', title: plainText(source?.title).trim() || 'Untitled', icon: emojiOf(source?.icon) };
    } catch (err: any) {
      if (!(err instanceof NotionError)) throw err;
    }
    throw new BadRequestException(reason);
  }

  async start(
    user: User,
    workspace: Workspace,
    input: { token: string; roots: Array<{ id: string; kind: 'page' | 'database' }>; spaceId: string; parentPageId?: string | null },
  ): Promise<NotionImportView> {
    const token = readToken(input.token);
    if (!input.roots?.length) throw new BadRequestException('Pick at least one page to import');
    if (input.roots.length > 50) throw new BadRequestException('Import at most 50 pages at a time');
    const ability = await this.spaceAbility.createForUser(user, input.spaceId);
    if (ability.cannot(SpaceCaslAction.Edit, SpaceCaslSubject.Page)) throw new ForbiddenException();
    let parentPageId: string | null = null;
    if (input.parentPageId) {
      const parent = await this.pageRepo.findById(input.parentPageId);
      if (!parent || parent.deletedAt || parent.spaceId !== input.spaceId) throw new BadRequestException('The parent page is not in that space');
      await this.pageAccess.validateCanEdit(parent, user);
      parentPageId = parent.id;
    }
    const busy = await this.db
      .selectFrom('notionImports')
      .select('id')
      .where('creatorId', '=', user.id)
      .where('status', 'in', ['queued', 'running'])
      .where('createdAt', '>', new Date(Date.now() - 2 * 3_600_000))
      .executeTakeFirst();
    if (busy) throw new BadRequestException('An import of yours is still running');
    const row = await this.db
      .insertInto('notionImports')
      .values({ workspaceId: workspace.id, creatorId: user.id, spaceId: input.spaceId, parentPageId, status: 'queued', progress: { step: 'queued', pages: 0, bases: 0, rows: 0, files: 0 } as any })
      .returningAll()
      .executeTakeFirstOrThrow();
    // the token travels encrypted to the worker and is not kept anywhere else
    await this.queue.add(
      QueueJob.NOTION_IMPORT,
      {
        importId: row.id,
        token: this.encryption.encrypt(token, EncryptionPurpose.INTEGRATION_TOKENS),
        roots: input.roots.map((r) => ({ id: norm(r.id), kind: r.kind === 'database' ? 'database' : 'page' })),
      },
      { removeOnComplete: true, removeOnFail: true, attempts: 1 },
    );
    return view(row);
  }

  async status(user: User, workspace: Workspace, importId: string): Promise<NotionImportView> {
    const row = await this.db
      .selectFrom('notionImports')
      .selectAll()
      .where('id', '=', importId)
      .where('workspaceId', '=', workspace.id)
      .where('creatorId', '=', user.id)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('Import not found');
    return view(row);
  }

  // The queue job.
  async process(data: { importId: string; token: string; roots: Array<{ id: string; kind: 'page' | 'database' }> }): Promise<void> {
    const job = await this.db.selectFrom('notionImports').selectAll().where('id', '=', data.importId).executeTakeFirst();
    if (!job || job.status !== 'queued') return;
    const counts = { step: 'reading', pages: 0, bases: 0, rows: 0, files: 0 };
    const report = { views: 0, roots: [] as Array<{ title: string; url: string }>, skipped: new Map<string, number>(), notes: [] as ImportNote[] };
    let lastSaved = 0;
    const progress = async (force = false) => {
      if (!force && Date.now() - lastSaved < 1_500) return;
      lastSaved = Date.now();
      await this.db.updateTable('notionImports').set({ status: 'running', progress: { ...counts } as any }).where('id', '=', job.id).execute();
    };
    try {
      const user = await this.userRepo.findById(job.creatorId, job.workspaceId);
      if (!user || user.deletedAt || user.deactivatedAt) throw new Error('The person who started the import is no longer active');
      const space = await this.db.selectFrom('spaces').select(['id', 'slug']).where('id', '=', job.spaceId).executeTakeFirst();
      if (!space) throw new Error('The space is gone');
      const client = new NotionClient(this.encryption.decrypt(data.token, EncryptionPurpose.INTEGRATION_TOKENS));
      await progress(true);

      // ---- read everything from Notion -----------------------------------
      const state = { pages: 0, rowPages: 0, rowScans: 0, notes: report.notes, done: new Set<string>(), picked: new Map<string, Node>() };
      let tree: Node[] = [];
      for (const root of data.roots) {
        const node = root.kind === 'database' ? await this.readDatabase(client, root.id, 0, state, counts, progress) : await this.readPage(client, root.id, 0, state, counts, progress);
        if (!node) continue;
        tree.push(node);
        state.picked.set(node.id, node);
      }
      // a page picked on its own that turned out to sit inside another picked page lives there
      tree = tree.filter((node) => !node.adopted);
      if (!tree.length) throw new Error('Nothing could be read: share the pages with the connection in Notion and try again');

      // ---- create the pages and bases, empty, so links have somewhere to go
      counts.step = 'creating';
      await progress(true);
      const links = new Map<string, string>();
      const allSources: Source[] = [];
      const create = async (node: Node, parentPageId: string | null) => {
        if (node.kind === 'database') {
          for (const [index, source] of node.sources.entries()) {
            const name = index === 0 ? node.title : `${node.title} · ${source.name || index + 1}`;
            const base = await this.baseService.create(user.id, job.workspaceId, {
              name,
              icon: node.icon ?? undefined,
              spaceId: job.spaceId,
              ...(parentPageId ? { parentPageId } : {}),
            } as any);
            const holder: Node = index === 0 ? node : { ...node, title: name, children: [], sources: [] };
            holder.pageId = base.id;
            holder.url = `/s/${space.slug}/p/${base.slugId}`;
            holder.source = source;
            source.node = holder;
            allSources.push(source);
            links.set(norm(source.id), holder.url);
            if (index === 0) links.set(node.id, holder.url);
            counts.bases++;
          }
        } else {
          const page = await this.pageService.create(user.id, job.workspaceId, {
            title: node.title,
            icon: node.icon ?? undefined,
            spaceId: job.spaceId,
            parentPageId: parentPageId ?? undefined,
          } as any);
          node.pageId = page.id;
          node.url = `/s/${space.slug}/p/${page.slugId}`;
          links.set(node.id, node.url);
        }
        await progress();
        for (const child of node.children) await create(child, node.pageId ?? parentPageId);
      };
      for (const node of tree) {
        await create(node, job.parentPageId);
        if (node.url) report.roots.push({ title: node.title, url: node.url });
      }

      // ---- bases: columns, rows, row pages, relations, views --------------
      for (const source of allSources) await this.fillBase(user, job.workspaceId, space.slug, source, links, report, counts, progress);
      await this.linkRelations(user, job.workspaceId, allSources, report.notes);
      for (const source of allSources) report.views += await this.makeViews(user, job.workspaceId, source, report.notes);

      // ---- the text of every page -----------------------------------------
      counts.step = 'writing';
      await progress(true);
      const files = { count: 0, notes: report.notes };
      const write = async (node: Node) => {
        if (node.kind === 'page' && node.pageId) {
          await this.writeContent(user, job, node.pageId, node.blocks, links, report.skipped, files, counts);
          await progress();
        }
        for (const child of node.children) await write(child);
      };
      for (const node of tree) await write(node);
      for (const source of allSources) {
        for (const row of source.rows) {
          if (!row.pageId) continue;
          await this.writeContent(user, job, row.pageId, row.blocks, links, report.skipped, files, counts);
          await progress();
        }
      }

      counts.step = 'done';
      await this.db
        .updateTable('notionImports')
        .set({
          status: 'done',
          progress: { ...counts } as any,
          report: {
            pages: counts.pages,
            bases: counts.bases,
            rows: counts.rows,
            files: counts.files,
            views: report.views,
            roots: report.roots,
            skipped: [...report.skipped.entries()].map(([type, count]) => ({ type, count })),
            notes: uniqueNotes(report.notes).slice(0, MAX_NOTES),
          } as any,
          finishedAt: new Date(),
        })
        .where('id', '=', job.id)
        .execute();
    } catch (err: any) {
      const message = String(err?.message ?? 'The import failed').slice(0, 500);
      this.logger.warn(`notion import ${job.id} failed: ${message}`);
      await this.db
        .updateTable('notionImports')
        .set({ status: 'failed', error: message, progress: { ...counts } as any, finishedAt: new Date() })
        .where('id', '=', job.id)
        .execute();
    }
  }

  // ---- reading -------------------------------------------------------------

  private async readPage(
    client: NotionClient,
    id: string,
    depth: number,
    state: { pages: number; notes: ImportNote[]; done: Set<string>; picked: Map<string, Node> },
    counts: { pages: number },
    progress: () => Promise<void>,
  ): Promise<Node | null> {
    // picked on its own and also part of another page that was picked: once
    if (state.done.has(norm(id))) return null;
    state.done.add(norm(id));
    if (state.pages >= MAX_PAGES) {
      state.notes.push({ code: 'max_pages', count: MAX_PAGES });
      return null;
    }
    let page: any;
    try {
      page = await client.page(id);
    } catch (err: any) {
      state.notes.push({ code: 'page_unreadable', detail: String(err?.message ?? '').slice(0, 120) });
      return null;
    }
    if (page?.in_trash) return null;
    state.pages++;
    counts.pages++;
    const node: Node = { id: norm(id), kind: 'page', title: pageTitle(page), icon: emojiOf(page?.icon), blocks: [], children: [], sources: [] };
    node.blocks = await this.readBlocks(client, id, 0);
    await progress();
    if (depth < MAX_DEPTH) {
      for (const child of childRefs(node.blocks)) {
        // already read because it was picked on its own: it takes its place here
        const picked = state.picked.get(norm(child.id));
        if (picked) {
          state.picked.delete(picked.id);
          picked.adopted = true;
          node.children.push(picked);
          continue;
        }
        const sub = child.type === 'child_database' ? await this.readDatabase(client, child.id, depth + 1, state as any, counts as any, progress) : await this.readPage(client, child.id, depth + 1, state, counts, progress);
        if (sub) node.children.push(sub);
      }
    }
    return node;
  }

  private async readBlocks(client: NotionClient, id: string, depth: number): Promise<NotionBlock[]> {
    let blocks: NotionBlock[];
    try {
      blocks = (await client.children(id)) as NotionBlock[];
    } catch {
      return [];
    }
    if (depth >= 8) return blocks;
    for (const block of blocks) {
      // a sub-page keeps its blocks for itself
      if (block.type === 'child_page' || block.type === 'child_database') continue;
      const original = block.type === 'synced_block' ? block.synced_block?.synced_from?.block_id : null;
      if (original) block.children = await this.readBlocks(client, String(original), depth + 1);
      else if (block.has_children) block.children = await this.readBlocks(client, block.id, depth + 1);
    }
    return blocks;
  }

  private async readDatabase(
    client: NotionClient,
    id: string,
    depth: number,
    state: { pages: number; rowPages: number; rowScans: number; notes: ImportNote[]; done: Set<string> },
    counts: { pages: number; rows: number },
    progress: () => Promise<void>,
  ): Promise<Node | null> {
    if (state.done.has(norm(id))) return null;
    state.done.add(norm(id));
    let database: any;
    try {
      database = await client.database(id);
    } catch (err: any) {
      state.notes.push({ code: 'database_unreadable', detail: String(err?.message ?? '').slice(0, 120) });
      return null;
    }
    if (database?.in_trash) return null;
    const title = plainText(database?.title).trim() || 'Untitled';
    const node: Node = { id: norm(id), kind: 'database', title, icon: emojiOf(database?.icon), blocks: [], children: [], sources: [] };
    const views = await client.views(id, MAX_VIEWS * 2).catch(() => [] as any[]);
    for (const ref of (database?.data_sources ?? []) as Array<{ id: string; name?: string }>) {
      let schema: any;
      try {
        schema = await client.dataSource(ref.id);
      } catch {
        continue;
      }
      const pages = await client.rows(ref.id, MAX_ROWS + 1).catch(() => [] as any[]);
      if (pages.length > MAX_ROWS) state.notes.push({ code: 'max_rows', name: title, count: MAX_ROWS });
      const rows: Row[] = [];
      for (const page of pages.slice(0, MAX_ROWS)) {
        if (page?.object !== 'page' || page?.in_trash) continue;
        const row: Row = { id: norm(page.id), title: pageTitle(page), properties: page.properties ?? {}, blocks: [] };
        if (state.rowPages < MAX_ROW_PAGES && state.rowScans < MAX_ROW_SCANS) {
          state.rowScans++;
          row.blocks = await this.readBlocks(client, page.id, 0);
          if (row.blocks.length) state.rowPages++;
        }
        rows.push(row);
        counts.rows++;
        await progress();
      }
      if (state.rowPages >= MAX_ROW_PAGES) state.notes.push({ code: 'max_row_pages', count: MAX_ROW_PAGES });
      else if (state.rowScans >= MAX_ROW_SCANS) state.notes.push({ code: 'max_row_scans', count: MAX_ROW_SCANS });
      node.sources.push({
        id: norm(ref.id),
        name: String(ref.name ?? ''),
        schema: schema?.properties ?? {},
        rows,
        views: views.filter((v) => !v?.data_source_id || norm(v.data_source_id) === norm(ref.id)),
      });
    }
    if (!node.sources.length) {
      state.notes.push({ code: 'no_table', name: title });
      return null;
    }
    return node;
  }

  // ---- bases ---------------------------------------------------------------

  private async fillBase(
    user: User,
    workspaceId: string,
    spaceSlug: string,
    source: Source,
    links: Map<string, string>,
    report: { notes: ImportNote[] },
    counts: { pages: number },
    progress: () => Promise<void>,
  ): Promise<void> {
    const pageId = source.node!.pageId!;
    const base = await this.baseService.getBaseInfo(pageId);
    const primary = ((base as any).properties as Array<{ id: string; isPrimary: boolean }>).find((p) => p.isPrimary);
    const mapped = mapSchema(source.schema, source.rows.map((r) => r.properties), report.notes);
    const ids = new Map<string, string>();
    for (const property of mapped) {
      if (!property.type || property.type === 'relation') continue;
      if (property.primary && primary) {
        await this.properties.update({ pageId, propertyId: primary.id, name: property.name } as any, workspaceId, user.id).catch(() => undefined);
        ids.set(property.name, primary.id);
        continue;
      }
      try {
        const created: any = await this.properties.create(workspaceId, { pageId, name: property.name, type: property.type, typeOptions: property.typeOptions } as any, user.id);
        ids.set(property.name, created.id ?? created.property?.id);
      } catch (err: any) {
        report.notes.push({ code: 'column_failed', name: property.notionName, detail: String(err?.message ?? '').slice(0, 100) });
      }
    }
    source.mapped = mapped;
    source.propertyIds = ids;

    // rows; the ones with text of their own get a page under the base
    let pageProperty: string | null = null;
    for (const row of source.rows) {
      const cells: Record<string, unknown> = {};
      for (const property of mapped) {
        const propertyId = ids.get(property.name);
        if (!propertyId || property.type === 'relation') continue;
        const value = cellOf(property, row.properties[property.notionName]);
        if (value !== undefined) cells[propertyId] = value;
      }
      let created: any;
      try {
        created = await this.rows.create(user.id, workspaceId, { pageId, cells } as any);
      } catch {
        // one cell the base does not take: keep the row with its title
        const title = primary ? { [primary.id]: row.title } : {};
        created = await this.rows.create(user.id, workspaceId, { pageId, cells: title } as any).catch(() => null);
        report.notes.push({ code: 'row_values', name: row.title });
      }
      if (!created) continue;
      row.rowId = created.id;
      if (row.blocks.length) {
        if (!pageProperty) {
          // a name no column of the database already has
          let name = 'Page';
          for (let n = 2; mapped.some((p) => p.type && p.name.toLowerCase() === name.toLowerCase()); n++) name = `Page ${n}`;
          const made: any = await this.properties.create(workspaceId, { pageId, name, type: 'page' } as any, user.id).catch(() => null);
          pageProperty = made?.id ?? made?.property?.id ?? null;
        }
        const page = await this.pageService.create(user.id, workspaceId, { title: row.title, spaceId: (base as any).spaceId, parentPageId: pageId } as any);
        row.pageId = page.id;
        counts.pages++;
        links.set(row.id, `/s/${spaceSlug}/p/${page.slugId}`);
        if (pageProperty) {
          await this.rows.update({ pageId, rowId: created.id, cells: { [pageProperty]: page.id } } as any, workspaceId, user.id).catch(() => undefined);
        }
      } else {
        // a link to the row goes to its base
        links.set(row.id, source.node!.url!);
      }
      await progress();
    }
  }

  // Relations, once every row of every base exists.
  private async linkRelations(user: User, workspaceId: string, sources: Source[], notes: ImportNote[]): Promise<void> {
    const bySource = new Map(sources.map((s) => [s.id, s]));
    const rowOf = new Map<string, string>();
    for (const source of sources) for (const row of source.rows) if (row.rowId) rowOf.set(row.id, row.rowId);
    for (const source of sources) {
      const pageId = source.node!.pageId!;
      for (const property of source.mapped ?? []) {
        if (property.type !== 'relation') continue;
        const target = property.relationTarget ? bySource.get(property.relationTarget) : undefined;
        if (!target) {
          notes.push({ code: 'relation_outside', name: property.notionName });
          continue;
        }
        let propertyId: string | undefined;
        try {
          const created: any = await this.properties.create(
            workspaceId,
            { pageId, name: property.name, type: 'relation', typeOptions: { targetPageId: target.node!.pageId, allowMultiple: true } } as any,
            user.id,
          );
          propertyId = created.id ?? created.property?.id;
        } catch (err: any) {
          notes.push({ code: 'column_failed', name: property.notionName, detail: String(err?.message ?? '').slice(0, 100) });
        }
        if (!propertyId) continue;
        for (const row of source.rows) {
          if (!row.rowId) continue;
          const refs = cellOf(property, row.properties[property.notionName]) as string[] | undefined;
          const rowIds = (refs ?? []).map((ref) => rowOf.get(ref)).filter(Boolean) as string[];
          if (!rowIds.length) continue;
          await this.rows.update({ pageId, rowId: row.rowId, cells: { [propertyId]: rowIds.slice(0, 200) } } as any, workspaceId, user.id).catch(() => undefined);
        }
      }
    }
  }

  private async makeViews(user: User, workspaceId: string, source: Source, notes: ImportNote[]): Promise<number> {
    const pageId = source.node!.pageId!;
    const ids = source.propertyIds ?? new Map<string, string>();
    const id = (name: string | undefined) => (name ? ids.get(name) : undefined);
    const existing = await this.views.listByBaseId(pageId, workspaceId);
    let made = 0;
    for (const raw of source.views.slice(0, MAX_VIEWS)) {
      const mapped = mapView(raw, source.mapped ?? [], notes);
      if (!mapped) continue;
      const config: Record<string, unknown> = {};
      if (id(mapped.config.groupBy)) config.groupByPropertyId = id(mapped.config.groupBy);
      if (id(mapped.config.calendarBy)) config.calendarPropertyId = id(mapped.config.calendarBy);
      if (id(mapped.config.timelineStart)) config.timelineStartPropertyId = id(mapped.config.timelineStart);
      if (id(mapped.config.timelineEnd)) config.timelineEndPropertyId = id(mapped.config.timelineEnd);
      if (mapped.config.cardSize) config.cardSize = mapped.config.cardSize;
      const hidden = (mapped.config.hidden ?? []).map(id).filter(Boolean);
      if (hidden.length) config.hiddenPropertyIds = hidden;
      const sorts = (mapped.config.sorts ?? []).map((s) => ({ propertyId: id(s.property), direction: s.direction })).filter((s) => s.propertyId);
      if (sorts.length) config.sorts = sorts;
      // a board with nothing to group by would be empty
      if (mapped.type === 'kanban' && !config.groupByPropertyId) continue;
      try {
        await this.views.create(user.id, workspaceId, { pageId, name: mapped.name, type: mapped.type, config } as any);
        made++;
      } catch (err: any) {
        notes.push({ code: 'view_failed', name: mapped.name, detail: String(err?.message ?? '').slice(0, 100) });
      }
    }
    // the table every new base starts with gives way to the views that came over
    if (made > 0) {
      for (const view of existing as Array<{ id: string }>) {
        await this.views.delete({ pageId, viewId: view.id } as any, workspaceId, user.id).catch(() => undefined);
      }
    }
    return made;
  }

  // ---- page text and files -------------------------------------------------

  private async writeContent(
    user: User,
    job: { id: string; workspaceId: string; spaceId: string },
    pageId: string,
    blocks: NotionBlock[],
    links: Map<string, string>,
    skipped: Map<string, number>,
    files: { count: number; notes: ImportNote[] },
    counts: { files: number },
  ): Promise<void> {
    if (!blocks.length) return;
    // files Notion hosts are copied first: their addresses expire
    const kept = new Map<string, string>();
    for (const file of hostedFiles(blocks)) {
      if (kept.has(file.url)) continue;
      if (files.count >= MAX_FILES) {
        files.notes.push({ code: 'max_files', count: MAX_FILES });
        break;
      }
      const src = await this.keepFile(user, job, pageId, file.url, file.name).catch(() => null);
      if (src) {
        kept.set(file.url, src);
        files.count++;
        counts.files++;
      }
    }
    const html = blocksToHtml(blocks, {
      linkFor: (id) => links.get(id) ?? null,
      fileFor: (url) => kept.get(url) ?? null,
      skipped,
    });
    if (!html) return;
    try {
      await this.pageService.updatePageContent(pageId, htmlToJson(html), 'replace', 'json', user);
    } catch (err: any) {
      files.notes.push({ code: 'page_text_failed', detail: String(err?.message ?? '').slice(0, 100) });
    }
  }

  private async keepFile(user: User, job: { workspaceId: string; spaceId: string }, pageId: string, url: string, name: string | null): Promise<string | null> {
    // files come from Notion's own storage, over https (the test stand-in aside)
    if (!/^https:\/\//i.test(url) && !process.env.NOTION_API_URL) return null;
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) return null;
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > MAX_FILE_BYTES) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    if (!buffer.length || buffer.length > MAX_FILE_BYTES) return null;
    const fileName = safeName(name || fileNameOf(url));
    const attachmentId = uuid7();
    const filePath = `${getAttachmentFolderPath(AttachmentType.File, job.workspaceId)}/${attachmentId}/${fileName}`;
    await this.storage.upload(filePath, buffer);
    await this.db
      .insertInto('attachments')
      .values({
        id: attachmentId,
        filePath,
        fileName,
        fileSize: buffer.length,
        mimeType: getMimeType(fileName),
        type: 'file',
        fileExt: path.extname(fileName).toLowerCase(),
        creatorId: user.id,
        workspaceId: job.workspaceId,
        pageId,
        spaceId: job.spaceId,
      } as any)
      .execute();
    return `/api/files/${attachmentId}/${encodeURIComponent(fileName)}`;
  }
}

// The same note said twice (a limit hit in several places) is one note.
function uniqueNotes(notes: ImportNote[]): ImportNote[] {
  const seen = new Set<string>();
  return notes.filter((note) => {
    const key = JSON.stringify([note.code, note.name ?? '', note.detail ?? '', note.count ?? '']);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// The id in a Notion link: the page shown in a side peek (?p=) when there
// is one, else the last id of the address. A bare id works too.
export function idFromLink(raw: unknown): string | null {
  const link = String(raw ?? '').trim();
  if (!link || link.length > 2_000) return null;
  const ID = /[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/gi;
  let path = link;
  try {
    const url = new URL(link);
    const peek = url.searchParams.get('p');
    if (peek && ID.test(peek)) return norm(peek.match(ID)![0]);
    path = url.pathname;
  } catch {
    // not an address: maybe the id itself
  }
  ID.lastIndex = 0;
  const found = path.match(ID);
  return found?.length ? norm(found[found.length - 1]) : null;
}

function readToken(raw: unknown): string {
  const token = String(raw ?? '').trim();
  if (token.length < 20 || token.length > 400 || /\s/.test(token)) throw new BadRequestException('Paste the secret of your Notion connection');
  return token;
}

function pageTitle(page: any): string {
  for (const value of Object.values(page?.properties ?? {}) as any[]) {
    if (value?.type === 'title') return plainText(value.title).trim() || 'Untitled';
  }
  return 'Untitled';
}

// Only an emoji travels as an icon; pictures and Notion's own icons do not.
function emojiOf(icon: any): string | null {
  return icon?.type === 'emoji' && typeof icon.emoji === 'string' ? icon.emoji : null;
}

// Sub-pages and databases wherever they sit in the page (inside a toggle, a column...).
function childRefs(blocks: NotionBlock[]): Array<{ id: string; type: string }> {
  const out: Array<{ id: string; type: string }> = [];
  for (const block of blocks) {
    if (block.type === 'child_page' || block.type === 'child_database') out.push({ id: block.id, type: block.type });
    else if (block.children?.length) out.push(...childRefs(block.children));
  }
  return out;
}

function hostedFiles(blocks: NotionBlock[]): Array<{ url: string; name: string | null }> {
  const out: Array<{ url: string; name: string | null }> = [];
  for (const block of blocks) {
    const data = block[block.type];
    if (['image', 'file', 'pdf', 'video', 'audio'].includes(block.type) && data?.type === 'file' && typeof data.file?.url === 'string') {
      out.push({ url: data.file.url, name: typeof data.name === 'string' ? data.name : null });
    }
    if (block.children?.length) out.push(...hostedFiles(block.children));
  }
  return out;
}

function fileNameOf(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() ?? '') || 'file';
  } catch {
    return 'file';
  }
}

function safeName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(-120);
  return cleaned || 'file';
}

function view(row: any): NotionImportView {
  const iso = (value: unknown) => (value ? new Date(value as any).toISOString() : null);
  return {
    id: row.id,
    status: row.status,
    progress: row.progress ?? null,
    report: row.report ?? null,
    error: row.error ?? null,
    createdAt: iso(row.createdAt)!,
    finishedAt: iso(row.finishedAt),
  };
}
