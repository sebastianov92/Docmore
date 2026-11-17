import { Injectable, Logger } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { pageNodeToDocxBuffer } from '@docmost/editor-ext';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { Page } from '@docmost/db/types/entity.types';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { jsonToNode } from '../../collaboration/collaboration.util';
import {
  getAttachmentIds,
  getProsemirrorContent,
} from '../../common/helpers/prosemirror/utils';
import { getPageTitle } from '../../common/helpers';
import { StorageService } from '../storage/storage.service';
import { DomainService } from '../environment/domain.service';
import { ExportService } from './export.service';
import { attachmentIdFromSrc } from './docx-export.utils';

type StoredAttachment = { id: string; filePath: string; pageId: string | null };

@Injectable()
export class DocxExportService {
  private readonly logger = new Logger(DocxExportService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly pagePermissionRepo: PagePermissionRepo,
    private readonly storageService: StorageService,
    private readonly domainService: DomainService,
    private readonly exportService: ExportService,
  ) {}

  async exportPage(page: Page, userId: string): Promise<Buffer> {
    const baseUrl = await this.getWorkspaceBaseUrl(page.workspaceId);
    const withLinks = await this.exportService.turnPageMentionsToLinks(
      getProsemirrorContent(page.content),
      page.workspaceId,
      baseUrl,
      userId,
    );

    // The title lives outside the document in the editor; Word readers expect it inside.
    const json = { ...withLinks, content: [...(withLinks.content ?? [])] };
    if (page.title) {
      json.content.unshift({
        type: 'heading',
        attrs: { level: 1 },
        content: [{ type: 'text', text: getPageTitle(page.title) }],
      });
    }

    const attachments = await this.resolveAttachments(page, userId, json);

    return pageNodeToDocxBuffer(jsonToNode(json), async (src) => {
      const attachmentId = attachmentIdFromSrc(src);
      const attachment = attachmentId && attachments.get(attachmentId);
      if (!attachment) {
        throw new Error(`image is not an accessible attachment: ${src}`);
      }
      const buffer = await this.storageService.read(attachment.filePath);
      return new Uint8Array(buffer);
    });
  }

  // Only attachments of this space that sit on pages the user may read are embedded.
  private async resolveAttachments(
    page: Page,
    userId: string,
    json: any,
  ): Promise<Map<string, StoredAttachment>> {
    const ids = getAttachmentIds(json);
    if (ids.length === 0) {
      return new Map();
    }

    const rows: StoredAttachment[] = await this.db
      .selectFrom('attachments')
      .select(['id', 'filePath', 'pageId'])
      .where('id', 'in', ids)
      .where('spaceId', '=', page.spaceId)
      .where('deletedAt', 'is', null)
      .execute();

    const foreignPageIds = [
      ...new Set(
        rows
          .map((row) => row.pageId)
          .filter((id): id is string => !!id && id !== page.id),
      ),
    ];
    const accessible = new Set<string>(
      foreignPageIds.length
        ? await this.pagePermissionRepo.filterAccessiblePageIds({
            pageIds: foreignPageIds,
            userId,
            spaceId: page.spaceId,
          })
        : [],
    );

    const allowed = rows.filter(
      (row) => row.pageId === page.id || (row.pageId && accessible.has(row.pageId)),
    );
    if (allowed.length < rows.length) {
      this.logger.debug(
        `docx export of ${page.id}: ${rows.length - allowed.length} attachment(s) skipped`,
      );
    }
    return new Map(allowed.map((row) => [row.id, row]));
  }

  private async getWorkspaceBaseUrl(workspaceId: string): Promise<string> {
    const workspace = await this.db
      .selectFrom('workspaces')
      .select('hostname')
      .where('id', '=', workspaceId)
      .executeTakeFirst();
    return this.domainService.getUrl(workspace?.hostname);
  }
}
