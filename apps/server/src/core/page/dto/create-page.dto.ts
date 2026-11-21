import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  ValidateIf,
} from 'class-validator';
import { Transform } from 'class-transformer';

export type ContentFormat = 'json' | 'markdown' | 'html';

export class CreatePageDto {
  // Chosen by a device that created the page offline, so everything it queued
  // against the page (body, comments, child pages) lands on the same id.
  @IsOptional()
  @IsUUID()
  id?: string;

  @IsOptional()
  @Matches(/^[0-9A-Za-z]{10}$/)
  slugId?: string;

  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  icon?: string;

  @IsOptional()
  @IsString()
  parentPageId?: string;

  @IsUUID()
  spaceId: string;

  @IsOptional()
  content?: string | object;

  @ValidateIf((o) => o.content !== undefined)
  @Transform(({ value }) => value?.toLowerCase() ?? 'json')
  @IsIn(['json', 'markdown', 'html'])
  format?: ContentFormat = 'json';
}
