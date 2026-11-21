import {
  IsArray,
  IsBoolean,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';

export class CreateRowDto {
  // Chosen by a device that created the row offline.
  @IsOptional()
  @IsUUID()
  id?: string;

  @IsUUID()
  pageId: string;

  @IsOptional()
  @IsObject()
  cells?: Record<string, unknown>;

  @IsOptional()
  @IsUUID()
  afterRowId?: string;

  // Template rows are kept apart from the data and seed new rows.
  @IsOptional()
  @IsBoolean()
  isTemplate?: boolean;

  @IsOptional()
  @IsUUID()
  fromTemplateId?: string;

  // Sub-item of another row of this base.
  @IsOptional()
  @IsUUID()
  parentRowId?: string;

  // Rows of this base that must finish first.
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  blockedBy?: string[];

  // Echoed back in the socket event so the originating client can skip
  // replaying its own write.
  @IsOptional()
  @IsString()
  requestId?: string;
}
