import { IsNotEmpty, IsString, IsUUID } from 'class-validator';

export class StartPdfExportDto {
  @IsUUID()
  pageId: string;
}

export class PdfRenderDto {
  @IsUUID()
  pageId: string;

  @IsString()
  @IsNotEmpty()
  token: string;
}

export class PdfDownloadDto {
  @IsUUID()
  fileTaskId: string;
}
