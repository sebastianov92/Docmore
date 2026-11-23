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
import { BaseAutomationService } from '../../../core/base/automation/base-automation.service';
import { AttachmentType } from '../../../core/attachment/attachment.constants';
import { getAttachmentFolderPath } from '../../../core/attachment/attachment.utils';
import { COVER_IMAGE_MIME_TYPES } from '../../../core/page/page-cover.constants';
import { getMimeType } from '../../../common/helpers/file.helper';
import { htmlToJson } from '../../../collaboration/collaboration.util';
import { NotionClient, NotionError } from './notion-client';
import { blocksToHtml, NotionBlock, plainText } from './notion-html';
import { cellOf, fileRef, ImportNote, MappedProperty, mapSchema, mapView, NotionFileRef } from './notion-schema';
import { fetch as outboundFetch } from 'undici';
import { OutboundAgentFactory } from '../../outbound/outbound-agent.factory';

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

type Row = {
  id: string;
  title: string;
  properties: Record<string, any>;
  blocks: NotionBlock[];
  // the cover of the row's page, for the cards of a gallery
  cover?: NotionFileRef | null;
  rowId?: string;
  pageId?: string;
};
// A file once it is kept here: what a files cell holds.
type KeptFile = { id: string; fileName: string; mimeType: string; fileSize: number; filePath: string };
type FileBudget = { count: number; notes: ImportNote[] };
type Source = {
  id: string;
  name: string;
  schema: Record<string, any>;
  rows: Row[];
  views: any[];
  node?: Node;
  mapped?: MappedProperty[];
  propertyIds?: Map<string, string>;
  // the column made to hold the pictures of the cards, when views ask for them
  coverPropertyId?: string;
  // Notion view id -> the view it became here
  viewIds?: Map<string, string>;
};
// A showing of a table somewhere else than its own database: the views it has there.
type Linked = { owner: Node; sourceId: string; views: any[] };
type ReadState = {
  pages: number;
  rowPages: number;
  rowScans: number;
  notes: ImportNote[];
  done: Set<string>;
  picked: Map<string, Node>;
  databases: Node[];
  sources: Map<string, Node>;
  // linked views by the id of the block that shows them
  linked: Map<string, Linked>;
  // database blocks with nothing readable in them, until what they show is known
  hollow: Node[];
};
type Node = {
  id: string;
  kind: 'page' | 'database';
  title: string;
  icon: string | null;
  // the picture across the top of the page
  cover?: NotionFileRef | null;
  blocks: NotionBlock[];
  children: Node[];
  sources: Source[];
  // one table of a database with several: which one this base holds
  source?: Source;
  pageId?: string;
  url?: string;
  // picked on its own, then found inside another picked page: it went there
  adopted?: boolean;
  // a database that shows its table in the page that holds it
  inline?: boolean;
  // another showing of a database that already came over (a linked view): no base of its own
  aliasOf?: Node;
  // the views that showing has, and the table they are over
  linkedViews?: any[];
  linkedSource?: string;
};

// what one import brings over at most
const MAX_PAGES = 1_500;
const MAX_DEPTH = 15;
const MAX_ROWS = 2_000;
const MAX_ROW_PAGES = 400;
// each row is asked for its text with one request: only so many per import
const MAX_ROW_SCANS = 1_000;
const MAX_VIEWS = 24;
// the column of a board for the cards with no option (the client's NO_VALUE_CHOICE_ID)
const NO_VALUE_CHOICE = '__no_value';
// files of one cell; the rest are left out
const MAX_CELL_FILES = 10;
// a file that lives outside Notion is asked for through the server's guard
// for outgoing requests, and may send it on to another address this often
const MAX_FILE_REDIRECTS = 3;
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
    private readonly automations: BaseAutomationService,
    private readonly spaceAbility: SpaceAbilityFactory,
    private readonly storage: StorageService,
    private readonly encryption: EncryptionService,
    private readonly outbound: OutboundAgentFactory,
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
      const state: ReadState = { pages: 0, rowPages: 0, rowScans: 0, notes: report.notes, done: new Set<string>(), picked: new Map<string, Node>(), databases: [], sources: new Map<string, Node>(), linked: new Map(), hollow: [] };
      let tree: Node[] = [];
      for (const root of data.roots) {
        const node = root.kind === 'database' ? await this.readDatabase(client, root.id, 0, state, counts, progress) : await this.readPage(client, root.id, 0, state, counts, progress);
        if (!node) continue;
        tree.push(node);
        state.picked.set(node.id, node);
      }
      // a page picked on its own that turned out to sit inside another picked page lives there
      tree = tree.filter((node) => !node.adopted);
      // blocks that showed nothing of their own: a linked view of a table read later, or nothing at all
      for (const node of state.hollow) {
        const hit = state.linked.get(node.id);
        if (hit) {
          node.aliasOf = hit.owner;
          node.linkedViews = hit.views;
          node.linkedSource = hit.sourceId;
        } else {
          report.notes.push({ code: 'no_table', name: node.title });
        }
      }
      if (!tree.length) throw new Error('Nothing could be read: share the pages with the connection in Notion and try again');

      // ---- create the pages and bases, empty, so links have somewhere to go
      counts.step = 'creating';
      await progress(true);
      const links = new Map<string, string>();
      // what each thing that has a link is called
      const titles = new Map<string, string>();
      // databases that show inline in their page: Notion id -> the base to show there
      const embeds = new Map<string, { pageId: string; viewId?: string | null }>();
      const aliases: Node[] = [];
      const allSources: Source[] = [];
      const create = async (node: Node, parentPageId: string | null) => {
        if (node.aliasOf) {
          // no base of its own: it points at the one that came over
          aliases.push(node);
          return;
        }
        // a database block with nothing to show
        if (node.kind === 'database' && !node.sources.length) return;
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
            titles.set(norm(source.id), name);
            if (index === 0) {
              links.set(node.id, holder.url);
              titles.set(node.id, node.title);
              if (node.inline) embeds.set(node.id, { pageId: base.id });
            }
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
          titles.set(node.id, node.title);
        }
        await progress();
        for (const child of node.children) await create(child, node.pageId ?? parentPageId);
      };
      for (const node of tree) {
        await create(node, job.parentPageId);
        if (node.url) report.roots.push({ title: node.title, url: node.url });
      }
      // the views of a linked showing become views of the base it shows
      for (const alias of aliases) {
        const target = alias.aliasOf!;
        if (target.url) links.set(alias.id, target.url);
        titles.set(alias.id, target.title);
        const source = target.sources.find((s) => s.id === alias.linkedSource) ?? target.sources[0];
        for (const view of alias.linkedViews ?? []) {
          if (source && !source.views.some((v) => v?.id === view?.id)) source.views.push(view);
        }
      }

      // ---- bases: columns, rows, row pages, relations, views --------------
      const files: FileBudget = { count: 0, notes: report.notes };
      for (const source of allSources) await this.fillBase(user, job, space.slug, source, links, report, counts, files, progress);
      await this.linkRelations(user, job.workspaceId, allSources, report.notes);
      for (const source of allSources) report.views += await this.makeViews(user, job.workspaceId, source, report.notes);
      // where a linked view sat, the base shows at that view
      for (const alias of aliases) {
        const target = alias.aliasOf!;
        if (!target.pageId) continue;
        const first = (alias.linkedViews ?? []).map((v) => target.sources.map((s) => s.viewIds?.get(String(v?.id))).find(Boolean)).find(Boolean);
        if (alias.linkedViews?.length || alias.inline) embeds.set(alias.id, { pageId: target.pageId, viewId: first ?? null });
      }
      // what a Notion button can be made to do: add a row to a base of this import
      const baseOf = new Map<string, { pageId: string; title: string }>();
      const icons = new Map<string, string>();
      const eachNode = (node: Node) => {
        const target = node.aliasOf ?? node;
        if (target.icon) icons.set(node.id, target.icon);
        if (node.kind === 'database' && target.pageId) baseOf.set(node.id, { pageId: target.pageId, title: target.title });
        for (const child of node.children) eachNode(child);
      };
      for (const node of tree) eachNode(node);
      for (const source of allSources) for (const row of source.rows) titles.set(row.id, row.title);
      const buttons = { baseOf, titles, icons, automations: new Map<string, string>(), guessed: 0, unset: 0 };

      // ---- the text of every page -----------------------------------------
      counts.step = 'writing';
      await progress(true);
      const write = async (node: Node) => {
        // a linked view has no page of its own: its cover is the one of the base it shows
        if (node.pageId && node.cover && !node.aliasOf) await this.setCover(user, job, node.pageId, node.cover, files, counts);
        if (node.kind === 'page' && node.pageId) {
          await this.writeContent(user, job, node.pageId, node.blocks, links, embeds, buttons, report.skipped, files, counts);
          await progress();
        }
        for (const child of node.children) await write(child);
      };
      for (const node of tree) await write(node);
      for (const source of allSources) {
        for (const row of source.rows) {
          if (!row.pageId) continue;
          if (row.cover) await this.setCover(user, job, row.pageId, row.cover, files, counts);
          await this.writeContent(user, job, row.pageId, row.blocks, links, embeds, buttons, report.skipped, files, counts);
          await progress();
        }
      }
      if (buttons.guessed) report.notes.push({ code: 'buttons_guessed', count: buttons.guessed });
      if (buttons.unset) report.notes.push({ code: 'buttons_unset', count: buttons.unset });

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
    state: ReadState,
    counts: { pages: number; rows: number },
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
    const node: Node = { id: norm(id), kind: 'page', title: pageTitle(page), icon: emojiOf(page?.icon), cover: fileRef(page?.cover), blocks: [], children: [], sources: [] };
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
        const sub = child.type === 'child_database' ? await this.readDatabase(client, child.id, depth + 1, state, counts, progress) : await this.readPage(client, child.id, depth + 1, state, counts, progress);
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
    state: ReadState,
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
    const node: Node = { id: norm(id), kind: 'database', title, icon: emojiOf(database?.icon), cover: fileRef(database?.cover), blocks: [], children: [], sources: [], inline: database?.is_inline === true };
    const refs = (database?.data_sources ?? []) as Array<{ id: string; name?: string }>;
    // a linked view of a table that already came over: the views it has here go to that table's base
    const known = state.linked.get(node.id);
    if (known) {
      node.aliasOf = known.owner;
      node.linkedSource = known.sourceId;
      // those views were listed by table, across the workspace, in no order;
      // asked of this block, they come in the order of its tabs
      const order = await client.viewIds(id, MAX_VIEWS).catch(() => [] as string[]);
      const at = new Map(order.map((viewId, index) => [norm(viewId), index]));
      const place = (view: any) => at.get(norm(String(view?.id ?? ''))) ?? Number.MAX_SAFE_INTEGER;
      node.linkedViews = [...known.views].sort((a, b) => place(a) - place(b));
      return node;
    }
    // every table it shows already came over with another database: it is a showing of that one
    const shown = refs.length ? state.sources.get(norm(refs[0].id)) : undefined;
    if (shown && refs.every((ref) => state.sources.get(norm(ref.id)) === shown)) {
      node.aliasOf = shown;
      node.linkedSource = norm(refs[0].id);
      node.linkedViews = await client.views({ databaseId: id }, MAX_VIEWS).catch(() => [] as any[]);
      return node;
    }
    const sameTitle = () => state.databases.find((other) => other.title === title && title !== 'Untitled');
    for (const ref of refs) {
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
        const row: Row = { id: norm(page.id), title: pageTitle(page), properties: page.properties ?? {}, blocks: [], cover: fileRef(page.cover) };
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
      // every view over this table: the database's own, and the linked ones
      // that show it from other blocks, kept for when those blocks come up
      let views = await client.views({ dataSourceId: ref.id }, MAX_VIEWS * 3).catch(() => [] as any[]);
      if (!views.length) views = await client.views({ databaseId: id }, MAX_VIEWS).catch(() => [] as any[]);
      const own: any[] = [];
      for (const view of views) {
        const holder = norm(view?.parent?.database_id ?? id);
        if (holder === node.id) {
          own.push(view);
          continue;
        }
        const entry = state.linked.get(holder) ?? { owner: node, sourceId: norm(ref.id), views: [] };
        entry.views.push(view);
        state.linked.set(holder, entry);
      }
      node.sources.push({ id: norm(ref.id), name: String(ref.name ?? ''), schema: schema?.properties ?? {}, rows, views: own });
    }
    // Notion hands a linked view over as a database of its own with nothing
    // in it (or nothing readable): when one of the same name already came,
    // this is another showing of that one
    const hollow = node.sources.every((source) => source.rows.length === 0 && Object.keys(source.schema).length <= 1);
    if (hollow) {
      // its own views say which table it shows
      const views = await client.views({ databaseId: id }, MAX_VIEWS).catch(() => [] as any[]);
      const sourceId = views.map((v) => norm(v?.data_source_id)).find((s) => s && state.sources.has(s));
      const owner = sourceId ? state.sources.get(sourceId) : sameTitle();
      if (owner) {
        node.sources = [];
        node.aliasOf = owner;
        node.linkedSource = sourceId;
        node.linkedViews = sourceId ? views.filter((v) => norm(v?.data_source_id) === sourceId) : [];
        return node;
      }
    }
    if (!node.sources.length) {
      // maybe a linked view of a table that is read later: decided once everything is read
      state.hollow.push(node);
      return node;
    }
    state.databases.push(node);
    for (const source of node.sources) state.sources.set(source.id, node);
    return node;
  }

  // ---- bases ---------------------------------------------------------------

  private async fillBase(
    user: User,
    job: { workspaceId: string; spaceId: string },
    spaceSlug: string,
    source: Source,
    links: Map<string, string>,
    report: { notes: ImportNote[] },
    counts: { pages: number; files: number },
    files: FileBudget,
    progress: () => Promise<void>,
  ): Promise<void> {
    const workspaceId = job.workspaceId;
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

    // The cards of a gallery can show the cover of each row's page, or the
    // first image of its text. Neither is a column in Notion; here the
    // picture of a card is a files column, so one is made to hold them.
    const asked = new Set<string>();
    for (const raw of source.views.slice(0, MAX_VIEWS)) {
      const from = mapView(raw, mapped, [])?.config.coverFrom;
      if (from) asked.add(from);
    }
    const coverOf = (row: Row): NotionFileRef | null => {
      if (asked.has('page_cover') && row.cover) return row.cover;
      if (asked.has('page_content')) return firstImage(row.blocks);
      return null;
    };
    if (asked.size && source.rows.some((row) => coverOf(row))) {
      let name = 'Cover';
      for (let n = 2; mapped.some((p) => p.type && p.name.toLowerCase() === name.toLowerCase()); n++) name = `Cover ${n}`;
      const made: any = await this.properties.create(workspaceId, { pageId, name, type: 'file' } as any, user.id).catch(() => null);
      source.coverPropertyId = made?.id ?? made?.property?.id ?? undefined;
    }
    const keepAll = async (refs: NotionFileRef[]): Promise<KeptFile[]> => {
      const kept: KeptFile[] = [];
      for (const ref of refs.slice(0, MAX_CELL_FILES)) {
        if (files.count >= MAX_FILES) {
          files.notes.push({ code: 'max_files', count: MAX_FILES });
          break;
        }
        const file = await this.keepAttachment(user, job, pageId, ref).catch(() => null);
        if (!file) continue;
        kept.push(file);
        files.count++;
        counts.files++;
      }
      return kept;
    };

    // rows; the ones with text of their own get a page under the base
    let pageProperty: string | null = null;
    // files columns some file of which could not be copied
    const lost = new Set<string>();
    for (const row of source.rows) {
      const cells: Record<string, unknown> = {};
      for (const property of mapped) {
        const propertyId = ids.get(property.name);
        if (!propertyId || property.type === 'relation') continue;
        const value = cellOf(property, row.properties[property.notionName]);
        if (value === undefined) continue;
        if (property.type === 'file') {
          // the files are copied first: a cell holds what is kept here
          const refs = value as NotionFileRef[];
          const kept = await keepAll(refs);
          if (kept.length) cells[propertyId] = kept;
          if (kept.length < refs.length) lost.add(property.notionName);
          continue;
        }
        cells[propertyId] = value;
      }
      if (source.coverPropertyId) {
        const cover = coverOf(row);
        const kept = cover ? await keepAll([cover]) : [];
        if (kept.length) cells[source.coverPropertyId] = kept;
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
    for (const name of lost) report.notes.push({ code: 'files_missing', name });
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
    // a database's own unnamed table and a linked one both arrive as "Table":
    // the second of a name gets a number, so the tabs can be told apart
    const taken = new Set<string>();
    const named = (name: string): string => {
      let out = name;
      for (let n = 2; taken.has(out.toLowerCase()); n++) out = `${name} ${n}`;
      taken.add(out.toLowerCase());
      return out;
    };
    for (const raw of source.views.slice(0, MAX_VIEWS)) {
      const mapped = mapView(raw, source.mapped ?? [], notes);
      if (!mapped) continue;
      const config: Record<string, unknown> = {};
      if (id(mapped.config.groupBy)) config.groupByPropertyId = id(mapped.config.groupBy);
      if (id(mapped.config.calendarBy)) config.calendarPropertyId = id(mapped.config.calendarBy);
      if (id(mapped.config.timelineStart)) config.timelineStartPropertyId = id(mapped.config.timelineStart);
      if (id(mapped.config.timelineEnd)) config.timelineEndPropertyId = id(mapped.config.timelineEnd);
      if (mapped.config.cardSize) config.cardSize = mapped.config.cardSize;
      if (id(mapped.config.cover)) config.coverPropertyId = id(mapped.config.cover);
      else if (mapped.config.coverFrom && source.coverPropertyId) config.coverPropertyId = source.coverPropertyId;
      // Notion leaves out the column of the cards with no option when there
      // are none; so does the board here
      if (mapped.type === 'kanban' && mapped.config.groupBy) {
        const by = (source.mapped ?? []).find((p) => p.name === mapped.config.groupBy);
        const every = by && source.rows.length > 0 && source.rows.every((row) => cellOf(by, row.properties[by.notionName]) !== undefined);
        if (every) config.hiddenChoiceIds = [NO_VALUE_CHOICE];
      }
      const hidden = (mapped.config.hidden ?? []).map(id).filter(Boolean);
      if (hidden.length) config.hiddenPropertyIds = hidden;
      const sorts = (mapped.config.sorts ?? []).map((s) => ({ propertyId: id(s.property), direction: s.direction })).filter((s) => s.propertyId);
      if (sorts.length) config.sorts = sorts;
      // a board with nothing to group by would be empty
      if (mapped.type === 'kanban' && !config.groupByPropertyId) continue;
      const name = named(mapped.name);
      try {
        const created: any = await this.views.create(user.id, workspaceId, { pageId, name, type: mapped.type, config } as any);
        if (created?.id && raw?.id) (source.viewIds ??= new Map()).set(String(raw.id), created.id);
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
    embeds: Map<string, { pageId: string; viewId?: string | null }>,
    buttons: { baseOf: Map<string, { pageId: string; title: string }>; titles: Map<string, string>; icons: Map<string, string>; automations: Map<string, string>; guessed: number; unset: number },
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
    // Notion does not say what a button does. The usual one adds a page to a
    // database of its page: each button gets, in order, one of the bases the
    // page shows (the ones shown in place first), and adds a row to it.
    const wanted = countButtons(blocks);
    const made: Array<{ label: string; pageId?: string | null; automationId?: string | null }> = [];
    if (wanted) {
      const shown = databaseBlocks(blocks).map((id) => ({ id, base: buttons.baseOf.get(id) })).filter((entry) => entry.base);
      const inPlace = shown.filter((entry) => embeds.has(entry.id));
      const candidates: Array<{ pageId: string; title: string }> = [];
      for (const entry of [...inPlace, ...shown]) {
        if (!candidates.some((c) => c.pageId === entry.base!.pageId)) candidates.push(entry.base!);
      }
      for (let i = 0; i < wanted; i++) {
        const target = candidates[i];
        const automationId = target ? await this.addRowAutomation(user, job.workspaceId, target.pageId, buttons.automations) : null;
        if (target && automationId) {
          made.push({ label: target.title, pageId: target.pageId, automationId });
          buttons.guessed++;
        } else {
          made.push({ label: 'Button' });
          buttons.unset++;
        }
      }
    }
    const html = blocksToHtml(blocks, {
      linkFor: (id) => links.get(id) ?? null,
      titleFor: (id) => buttons.titles.get(id) ?? null,
      iconFor: (id) => buttons.icons.get(id) ?? null,
      embedFor: (id) => embeds.get(id) ?? null,
      buttonFor: () => made.shift() ?? null,
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

  // One automation per base that a button can run: it adds an empty row.
  private async addRowAutomation(user: User, workspaceId: string, basePageId: string, cache: Map<string, string>): Promise<string | null> {
    const known = cache.get(basePageId);
    if (known) return known;
    try {
      const created: any = await this.automations.create(
        { pageId: basePageId, name: 'Add a row', enabled: true, trigger: { type: 'button' }, actions: [{ type: 'create_row', cells: {} }] } as any,
        workspaceId,
        user.id,
      );
      if (!created?.id) return null;
      cache.set(basePageId, created.id);
      return created.id;
    } catch {
      return null;
    }
  }

  private async keepFile(user: User, job: { workspaceId: string; spaceId: string }, pageId: string, url: string, name: string | null): Promise<string | null> {
    const kept = await this.keepAttachment(user, job, pageId, { url, name, hosted: true });
    return kept ? `/api/files/${kept.id}/${encodeURIComponent(kept.fileName)}` : null;
  }

  // The bytes of a file. One Notion hosts comes from Notion's own storage,
  // over https (the test stand-in aside). One that lives elsewhere is any
  // address a Notion page names: it goes through the guard for outgoing
  // requests, pinned to the address that was checked, and so does every
  // address it is sent on to.
  private async download(ref: NotionFileRef): Promise<Buffer | null> {
    const fits = (res: { headers: { get(name: string): string | null } }) => Number(res.headers.get('content-length') ?? 0) <= MAX_FILE_BYTES;
    if (ref.hosted) {
      if (!/^https:\/\//i.test(ref.url) && !process.env.NOTION_API_URL) return null;
      const res = await fetch(ref.url, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok || !fits(res)) return null;
      return Buffer.from(await res.arrayBuffer());
    }
    let url = ref.url;
    for (let hop = 0; hop <= MAX_FILE_REDIRECTS; hop++) {
      if (!/^https:\/\//i.test(url)) return null;
      const lease = await this.outbound.lease(url);
      try {
        const res = await outboundFetch(url, { dispatcher: lease.dispatcher, redirect: 'manual', signal: AbortSignal.timeout(60_000) });
        if (res.status >= 300 && res.status < 400) {
          const next = res.headers.get('location');
          if (!next) return null;
          url = new URL(next, url).toString();
          continue;
        }
        if (!res.ok || !fits(res)) return null;
        return Buffer.from(await res.arrayBuffer());
      } finally {
        await lease.release().catch(() => undefined);
      }
    }
    return null;
  }

  // The picture across the top of a page: kept as the cover of the page here.
  private async setCover(
    user: User,
    job: { workspaceId: string; spaceId: string },
    pageId: string,
    ref: NotionFileRef,
    files: FileBudget,
    counts: { files: number },
  ): Promise<void> {
    if (files.count >= MAX_FILES) {
      files.notes.push({ code: 'max_files', count: MAX_FILES });
      return;
    }
    const kept = await this.keepAttachment(user, job, pageId, ref, 'cover').catch(() => null);
    if (!kept) return;
    files.count++;
    counts.files++;
    await this.db
      .updateTable('pages')
      .set({ coverPhoto: `/api/files/${kept.id}/${encodeURIComponent(kept.fileName)}`, coverPosition: null, coverAttribution: null } as any)
      .where('id', '=', pageId)
      .execute();
  }

  // `as`: a file of a page or of a cell, or the cover of the page (an image
  // of the kinds a cover can be, kept as a cover upload is).
  private async keepAttachment(
    user: User,
    job: { workspaceId: string; spaceId: string },
    pageId: string,
    ref: NotionFileRef,
    as: 'file' | 'cover' = 'file',
  ): Promise<KeptFile | null> {
    const buffer = await this.download(ref);
    if (!buffer?.length || buffer.length > MAX_FILE_BYTES) return null;
    const fileName = withExtension(safeName(ref.name || fileNameOf(ref.url)), buffer);
    if (as === 'cover' && !COVER_IMAGE_MIME_TYPES.includes(getMimeType(fileName))) return null;
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
        type: as === 'cover' ? AttachmentType.PageCover : AttachmentType.File,
        fileExt: path.extname(fileName).toLowerCase(),
        creatorId: user.id,
        workspaceId: job.workspaceId,
        pageId,
        spaceId: job.spaceId,
      } as any)
      .execute();
    return { id: attachmentId, fileName, mimeType: getMimeType(fileName), fileSize: buffer.length, filePath };
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

function countButtons(blocks: NotionBlock[]): number {
  let n = 0;
  for (const block of blocks) {
    if (block.type === 'unsupported' && block.unsupported?.block_type === 'button') n++;
    if (block.children?.length) n += countButtons(block.children);
  }
  return n;
}

// The databases a page shows, in the order they come up (Notion ids).
function databaseBlocks(blocks: NotionBlock[]): string[] {
  const out: string[] = [];
  for (const block of blocks) {
    if (block.type === 'child_database') out.push(norm(block.id));
    else if (block.type !== 'child_page' && block.children?.length) out.push(...databaseBlocks(block.children));
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

// The first image in the text of a page, as a gallery shows it on a card.
function firstImage(blocks: NotionBlock[]): NotionFileRef | null {
  for (const block of blocks) {
    if (block.type === 'image') {
      const found = fileRef(block.image);
      if (found) return found;
    }
    if (block.type !== 'child_page' && block.children?.length) {
      const inside = firstImage(block.children);
      if (inside) return inside;
    }
  }
  return null;
}

// A picture named without its kind ("photo-1500…" from an image service)
// would not be shown as one: the name gets the extension its bytes say.
function withExtension(name: string, bytes: Buffer): string {
  if (path.extname(name)) return name;
  const head = bytes.subarray(0, 12);
  const starts = (...values: number[]) => values.every((value, index) => head[index] === value);
  if (starts(0xff, 0xd8, 0xff)) return `${name}.jpg`;
  if (starts(0x89, 0x50, 0x4e, 0x47)) return `${name}.png`;
  if (starts(0x47, 0x49, 0x46, 0x38)) return `${name}.gif`;
  if (starts(0x52, 0x49, 0x46, 0x46) && head.subarray(8, 12).toString('latin1') === 'WEBP') return `${name}.webp`;
  return name;
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
