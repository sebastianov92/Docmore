import {
  IsBoolean,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';

export class CreateRowDto {
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

  // Echoed back in the socket event so the originating client can skip
  // replaying its own write.
  @IsOptional()
  @IsString()
  requestId?: string;
}
