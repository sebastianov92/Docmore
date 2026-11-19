import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
import { executeTx } from '@docmost/db/utils';
import { BaseRepo } from '@docmost/db/repos/base/base.repo';
import { BasePropertyRepo } from '@docmost/db/repos/base/base-property.repo';
import { BaseRowRepo } from '@docmost/db/repos/base/base-row.repo';
import { BaseViewRepo } from '@docmost/db/repos/base/base-view.repo';
import { PageService } from '../../page/services/page.service';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { BaseTemplate, CreateBaseDto } from '../dto/create-base.dto';
import { UpdateBaseDto } from '../dto/update-base.dto';
import { BasePropertyType } from '../base.schemas';
import { generateJitteredKeyBetween } from 'fractional-indexing-jittered';
import { generateBaseChoiceId } from '../../../common/helpers/nanoid.utils';

type BaseSeedDefaults = { extraTextProperties?: number; defaultRows?: number };
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';

@Injectable()
export class BaseService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly baseRepo: BaseRepo,
    private readonly basePropertyRepo: BasePropertyRepo,
    private readonly baseRowRepo: BaseRowRepo,
    private readonly baseViewRepo: BaseViewRepo,
    private readonly pageService: PageService,
    private readonly pageRepo: PageRepo,
  ) {}

  async create(
    userId: string,
    workspaceId: string,
    dto: CreateBaseDto,
    defaults: BaseSeedDefaults = {},
  ) {
    return executeTx(this.db, async (trx) => {
      const page = await this.pageService.create(
        userId,
        workspaceId,
        {
          title: dto.name ?? 'Untitled',
          icon: dto.icon,
          spaceId: dto.spaceId,
          parentPageId: dto.parentPageId,
        } as any,
        trx,
        true,
      );
      await this.seedBase(page.id, workspaceId, userId, defaults, dto.template, trx);
      return this.baseRepo.findById(page.id, {
        includeProperties: true,
        includeViews: true,
        trx,
      });
    });
  }

  // Turns an empty page into a base in place: it keeps its id, slug, title,
  // position in the tree and permissions.
  async convert(
    userId: string,
    workspaceId: string,
    pageId: string,
    template?: BaseTemplate,
  ) {
    return executeTx(this.db, async (trx) => {
      const page = await trx
        .selectFrom('pages')
        .select(['id', 'isBase', 'content', 'textContent'])
        .where('id', '=', pageId)
        .where('workspaceId', '=', workspaceId)
        .executeTakeFirst();
      if (!page) throw new NotFoundException('Page not found');
      if (page.isBase) throw new BadRequestException('This page is already a base');
      if (
        !isEmptyDocument(page.content) ||
        (page.textContent && page.textContent.trim().length > 0)
      ) {
        throw new BadRequestException('Only an empty page can become a base');
      }
      await trx
        .updateTable('pages')
        .set({ isBase: true, updatedAt: new Date() })
        .where('id', '=', pageId)
        .execute();
      await this.seedBase(pageId, workspaceId, userId, {}, template, trx);
      return this.baseRepo.findById(pageId, {
        includeProperties: true,
        includeViews: true,
        trx,
      });
    });
  }

  // The starting shape of every base: a primary Title column, optional
  // extra text columns and empty rows (the inline-embed flow asks for them
  // so the base is usable on first paint), a Table view, and for the kanban
  // template a Status column with a Kanban view in front.
  private async seedBase(
    pageId: string,
    workspaceId: string,
    userId: string,
    defaults: BaseSeedDefaults,
    template: BaseTemplate | undefined,
    trx: KyselyTransaction,
  ) {
    const firstPosition = generateJitteredKeyBetween(null, null);
    await this.basePropertyRepo.insertProperty(
      {
        pageId,
        name: 'Title',
        type: BasePropertyType.TEXT,
        position: firstPosition,
        isPrimary: true,
        workspaceId,
      },
      trx,
    );

    let lastPropertyPosition = firstPosition;
    const extraTextProperties = defaults.extraTextProperties ?? 0;
    for (let i = 0; i < extraTextProperties; i++) {
      const next = generateJitteredKeyBetween(lastPropertyPosition, null);
      await this.basePropertyRepo.insertProperty(
        {
          pageId,
          name: `Text ${i + 1}`,
          type: BasePropertyType.TEXT,
          position: next,
          isPrimary: false,
          workspaceId,
        },
        trx,
      );
      lastPropertyPosition = next;
    }

    let viewPosition = firstPosition;
    if (template === 'kanban') {
      const choices = [
        { id: generateBaseChoiceId(), name: 'Not started', color: 'gray', category: 'todo' },
        { id: generateBaseChoiceId(), name: 'In progress', color: 'blue', category: 'inProgress' },
        { id: generateBaseChoiceId(), name: 'Done', color: 'green', category: 'complete' },
      ];
      const statusPosition = generateJitteredKeyBetween(lastPropertyPosition, null);
      const status = await this.basePropertyRepo.insertProperty(
        {
          pageId,
          name: 'Status',
          type: BasePropertyType.STATUS,
          position: statusPosition,
          isPrimary: false,
          workspaceId,
          typeOptions: {
            choices,
            choiceOrder: choices.map((c) => c.id),
            defaultValue: choices[0].id,
          } as any,
        },
        trx,
      );
      lastPropertyPosition = statusPosition;
      await this.baseViewRepo.insertView(
        {
          pageId,
          name: 'Kanban',
          type: 'kanban',
          position: viewPosition,
          config: { groupByPropertyId: status.id } as any,
          workspaceId,
          creatorId: userId,
        },
        { trx },
      );
      viewPosition = generateJitteredKeyBetween(viewPosition, null);
    }

    await this.baseViewRepo.insertView(
      {
        pageId,
        name: 'Table',
        type: 'table',
        position: viewPosition,
        config: {},
        workspaceId,
        creatorId: userId,
      },
      { trx },
    );

    let lastRowPosition: string | null = null;
    const defaultRows = defaults.defaultRows ?? 0;
    for (let i = 0; i < defaultRows; i++) {
      const next = generateJitteredKeyBetween(lastRowPosition, null);
      await this.baseRowRepo.insertRow(
        {
          pageId,
          workspaceId,
          position: next,
          cells: {},
          creatorId: userId,
        },
        { trx },
      );
      lastRowPosition = next;
    }
  }

  async getBaseInfo(pageId: string) {
    const base = await this.baseRepo.findById(pageId, {
      includeProperties: true,
      includeViews: true,
    });

    if (!base) {
      throw new NotFoundException('Base not found');
    }

    return base;
  }

  async update(dto: UpdateBaseDto) {
    const base = await this.baseRepo.findById(dto.pageId);
    if (!base) {
      throw new NotFoundException('Base not found');
    }

    await this.pageRepo.updatePage(
      {
        ...(dto.name !== undefined && { title: dto.name }),
        ...(dto.icon !== undefined && { icon: dto.icon }),
        ...(dto.locked !== undefined && { baseLocked: dto.locked }),
      },
      dto.pageId,
    );

    return this.baseRepo.findById(dto.pageId);
  }

  async delete(pageId: string) {
    const base = await this.baseRepo.findById(pageId);
    if (!base) {
      throw new NotFoundException('Base not found');
    }

    await this.baseRepo.softDelete(pageId);
  }

  async listBySpaceId(spaceId: string, pagination: PaginationOptions) {
    return this.baseRepo.findBySpaceId(spaceId, pagination);
  }
}

// An editor document with nothing but empty paragraphs counts as empty.
function isEmptyDocument(content: unknown): boolean {
  const nodes = (content as { content?: unknown[] } | null)?.content;
  if (!Array.isArray(nodes) || nodes.length === 0) return true;
  return nodes.every((node: any) => {
    if (node?.type !== 'paragraph') return false;
    return !(Array.isArray(node.content) && node.content.length > 0);
  });
}
