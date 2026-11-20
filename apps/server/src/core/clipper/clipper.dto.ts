import { IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class ClipDto {
  @IsUUID()
  spaceId: string;

  @IsOptional()
  @IsString()
  parentPageId?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  url: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  title?: string;

  // the clipped HTML (selection or article); the server fetches the URL when missing
  @IsOptional()
  @IsString()
  @MaxLength(3_000_000)
  html?: string;
}
