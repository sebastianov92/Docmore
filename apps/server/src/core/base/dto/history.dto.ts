import { IsDateString, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class ListHistoryDto {
  @IsUUID()
  pageId: string;

  @IsOptional()
  @IsUUID()
  rowId?: string;

  // versions older than this moment (paging)
  @IsOptional()
  @IsDateString()
  before?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

export class RestoreVersionDto {
  @IsUUID()
  pageId: string;

  @IsUUID()
  versionId: string;
}

export class RestoreDeletedDto {
  @IsUUID()
  pageId: string;

  // rows deleted at or after this moment come back
  @IsDateString()
  since: string;
}
