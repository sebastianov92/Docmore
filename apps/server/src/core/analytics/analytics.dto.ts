import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class TrackViewDto {
  @IsUUID()
  pageId: string;
}

export class PageStatsDto {
  @IsUUID()
  pageId: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  days?: number;
}

export class WorkspaceStatsDto {
  @IsOptional()
  @IsUUID()
  spaceId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  days?: number;
}
