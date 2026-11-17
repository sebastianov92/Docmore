import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { load } from 'cheerio';
import { v7 as uuid7 } from 'uuid';
import { imageDimensionsFromData } from 'image-dimensions';
import { markdownToHtml } from '@docmost/editor-ext';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { StorageService } from '../../storage/storage.service';
import { getAttachmentFolderPath } from '../../../core/attachment/attachment.utils';
import { AttachmentType } from '../../../core/attachment/attachment.constants';
import { unwrapFromParagraph } from '../utils/import-formatter';
import {
  DOCX_STYLE_MAP,
  ImportedImageRef,
  MAX_IMPORTED_IMAGES,
  MAX_IMPORTED_IMAGE_BYTES,
  MIN_IMPORTED_IMAGE_SIDE,
  PdfPageText,
  imageExtensionFor,
  imageFileName,
  imageHtml,
  pdfHasText,
  usablePdfPages,
} from '../utils/document-import.utils';

interface ImportTarget {
  workspaceId: string;
  spaceId: string;
  pageId: string;
  userId: string;
}

// Turns a Word or PDF file into the HTML the page importer already knows
// how to read. Images inside the document become page attachments; the
// page id is minted before the page row exists, which the attachments
// table allows.
@Injectable()
export class DocumentImportService {
  private readonly logger = new Logger(DocumentImportService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly storageService: StorageService,
  ) {}

  async convertDocxToHtml(buffer: Buffer, target: ImportTarget): Promise<string> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mammoth = require('mammoth');
    const images = new ImageStore(this, target);

    const result = await mammoth.convertToHtml(
      { buffer },
      {
        styleMap: DOCX_STYLE_MAP,
        convertImage: mammoth.images.imgElement(async (image: any) => {
          const stored = await images.store(
            await image.readAsBuffer(),
            image.contentType,
          );
          if (!stored) {
            // Dropped below: an <img> without an attachment is one the
            // browser could not show anyway.
            return { src: '', 'data-skip': '1' };
          }
          return {
            src: stored.apiFilePath,
            'data-attachment-id': stored.attachmentId,
            width: String(stored.width ?? 600),
            ...(stored.height ? { height: String(stored.height) } : {}),
            'data-align': 'center',
          };
        }),
      },
    );

    for (const message of result.messages ?? []) {
      this.logger.debug(`docx import: ${message.type}: ${message.message}`);
    }

    const $ = load(result.value ?? '');
    $('img[data-skip]').remove();
    $('img[data-attachment-id]').each((_, el) => {
      unwrapFromParagraph($, $(el));
    });
    // Word's empty spacer paragraphs become empty editor blocks otherwise.
    $('p')
      .filter((_, el) => $(el).text().trim() === '' && $(el).children().length === 0)
      .remove();

    return $.html() || '';
  }

  async convertPdfToHtml(buffer: Buffer, target: ImportTarget): Promise<string> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pdf = require('@docmost/pdf-inspector');

    let pages: PdfPageText[];
    try {
      const extraction = pdf.extractPagesMarkdown(buffer);
      pages = extraction.pages ?? [];
    } catch (err: any) {
      this.logger.warn(`pdf import: could not parse file: ${err?.message}`);
      throw new BadRequestException(
        'This PDF could not be read. It may be damaged or password protected.',
      );
    }

    // Embedded bitmaps, grouped by page and ordered top to bottom.
    let extracted: any[] = [];
    try {
      extracted = pdf.extractImages(buffer) ?? [];
    } catch (err: any) {
      this.logger.debug(`pdf import: image extraction failed: ${err?.message}`);
    }
    const imagesByPage = new Map<number, any[]>();
    for (const image of extracted) {
      const list = imagesByPage.get(image.page) ?? [];
      list.push(image);
      imagesByPage.set(image.page, list);
    }
    for (const list of imagesByPage.values()) {
      list.sort((a, b) => a.y - b.y || a.x - b.x);
    }

    const textPages = usablePdfPages(pages);
    if (!pdfHasText(pages) && extracted.length === 0) {
      throw new BadRequestException(
        'No readable text found in this PDF. Scanned documents need OCR before they can be imported.',
      );
    }

    const images = new ImageStore(this, target);
    const pageCount = Math.max(
      pages.length,
      ...[...imagesByPage.keys()].map((p) => p),
    );
    const parts: string[] = [];

    for (let index = 0; index < pageCount; index++) {
      const text = textPages.find((p) => p.page === index);
      if (text) {
        parts.push(await markdownToHtml(text.markdown));
      }
      // ExtractedImage.page is 1-indexed; PageMarkdownResult.page is 0-indexed.
      for (const image of imagesByPage.get(index + 1) ?? []) {
        const contentType =
          String(image.format).toLowerCase() === 'png' ? 'image/png' : 'image/jpeg';
        const stored = await images.store(image.data, contentType);
        if (stored) {
          parts.push(imageHtml(stored));
        }
      }
    }

    return parts.join('\n');
  }

  // Writes one embedded image to storage and the attachments table. Returns
  // null for images that are not worth importing.
  async storeImage(
    data: Buffer,
    contentType: string,
    index: number,
    target: ImportTarget,
  ): Promise<ImportedImageRef | null> {
    const ext = imageExtensionFor(contentType);
    if (!ext || !data || data.length === 0 || data.length > MAX_IMPORTED_IMAGE_BYTES) {
      return null;
    }

    let width: number | null = null;
    let height: number | null = null;
    try {
      const natural = imageDimensionsFromData(new Uint8Array(data));
      if (natural) {
        width = natural.width;
        height = natural.height;
      }
    } catch {
      /* unknown size: the editor falls back to a default width */
    }
    if (
      width !== null &&
      height !== null &&
      (width < MIN_IMPORTED_IMAGE_SIDE || height < MIN_IMPORTED_IMAGE_SIDE)
    ) {
      return null;
    }

    const attachmentId = uuid7();
    const fileName = imageFileName(index, ext);
    const filePath = `${getAttachmentFolderPath(AttachmentType.File, target.workspaceId)}/${attachmentId}/${fileName}`;

    await this.storageService.upload(filePath, data);
    await this.db
      .insertInto('attachments')
      .values({
        id: attachmentId,
        filePath,
        fileName,
        fileSize: data.length,
        mimeType: contentType === 'image/jpg' ? 'image/jpeg' : contentType,
        type: AttachmentType.File,
        fileExt: ext,
        creatorId: target.userId,
        workspaceId: target.workspaceId,
        pageId: target.pageId,
        spaceId: target.spaceId,
      })
      .execute();

    return {
      attachmentId,
      apiFilePath: `/api/files/${attachmentId}/${fileName}`,
      width,
      height,
    };
  }
}

// Counts images per document so file names stay ordered and the cap holds.
class ImageStore {
  private count = 0;

  constructor(
    private readonly service: DocumentImportService,
    private readonly target: ImportTarget,
  ) {}

  async store(data: Buffer, contentType: string): Promise<ImportedImageRef | null> {
    if (this.count >= MAX_IMPORTED_IMAGES) {
      return null;
    }
    const stored = await this.service.storeImage(
      data,
      contentType,
      this.count + 1,
      this.target,
    );
    if (stored) {
      this.count++;
    }
    return stored;
  }
}
