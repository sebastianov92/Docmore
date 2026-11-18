import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { ListRowsDto } from './update-row.dto';

// Public readers reach a base through a share link (shareId) or through a
// published space (no shareId).
export class PublicBaseInfoDto {
  @IsUUID()
  pageId: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  shareId?: string;
}

export class PublicBaseRowsDto extends ListRowsDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  shareId?: string;
}
