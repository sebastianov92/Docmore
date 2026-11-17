import { IsUUID } from 'class-validator';

export class DocxExportDto {
  @IsUUID()
  pageId: string;
}
