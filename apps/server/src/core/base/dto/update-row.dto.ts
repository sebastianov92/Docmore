import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { BASE_PROPERTY_ID_RE } from '../base-ids';
import { Type } from 'class-transformer';
// `filter` / `search` shapes are validated by the engine's Zod schemas
// at the service boundary (`core/base/engine/schema.zod.ts`).

export class UpdateRowDto {
  @IsUUID()
  rowId: string;

  @IsUUID()
  pageId: string;

  @IsObject()
  cells: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  position?: string;

  // null clears the parent / the dependencies
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  parentRowId?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsArray()
  @IsUUID('all', { each: true })
  blockedBy?: string[] | null;

  @IsOptional()
  @IsString()
  requestId?: string;
}

export class DeleteRowDto {
  @IsUUID()
  rowId: string;

  @IsUUID()
  pageId: string;

  @IsOptional()
  @IsString()
  requestId?: string;
}

export class RowIdDto {
  @IsUUID()
  rowId: string;

  @IsUUID()
  pageId: string;
}

class SortDto {
  @Matches(BASE_PROPERTY_ID_RE)
  propertyId: string;

  @IsIn(['asc', 'desc'])
  direction: 'asc' | 'desc';
}

export class ListRowsDto {
  @IsUUID()
  pageId: string;

  @IsOptional()
  @IsUUID()
  viewId?: string;

  // Compound filter tree. Shape validated by the engine's Zod schema at
  // the service boundary.
  @IsOptional()
  @IsObject()
  filter?: unknown;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SortDto)
  sorts?: SortDto[];

  // `{ query, mode? }` — Zod-validated at the service boundary.
  @IsOptional()
  @IsObject()
  search?: unknown;

  // `true` lists the base's template rows instead of its data.
  @IsOptional()
  @IsBoolean()
  templates?: boolean;
}

export class CountRowsDto {
  @IsUUID()
  pageId: string;

  @IsOptional()
  @IsObject()
  filter?: unknown;

  @IsOptional()
  @IsObject()
  search?: unknown;

  // Opt-in for an exact (but capped) count. Default is an EXPLAIN-plan
  // estimate — cheap and good enough for "≈ N rows" headers.
  @IsOptional()
  @IsBoolean()
  exact?: boolean;
}

export class ReorderRowDto {
  @IsUUID()
  rowId: string;

  @IsUUID()
  pageId: string;

  @IsString()
  @IsNotEmpty()
  position: string;

  @IsOptional()
  @IsString()
  requestId?: string;
}

export class DeleteRowsDto {
  @IsUUID()
  pageId: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  rowIds: string[];

  @IsOptional()
  @IsString()
  requestId?: string;
}
