import {
  IsBoolean,
  IsDateString,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class CreateShareDto {
  // null clears the password; absent keeps it
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MinLength(4)
  @MaxLength(100)
  password?: string | null;

  // ISO date; null means never
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsDateString()
  expiresAt?: string | null;

  @IsString()
  @IsNotEmpty()
  pageId: string;

  @IsBoolean()
  @IsOptional()
  includeSubPages: boolean;

  @IsOptional()
  @IsBoolean()
  searchIndexing: boolean;
}

export class UpdateShareDto extends CreateShareDto {
  @IsString()
  @IsNotEmpty()
  shareId: string;

  @IsString()
  @IsOptional()
  pageId: string;
}

export class ShareIdDto {
  @IsString()
  @IsNotEmpty()
  shareId: string;
}

export class SpaceIdDto {
  @IsUUID()
  spaceId: string;
}

export class ShareInfoDto {
  @IsString()
  @IsOptional()
  shareId?: string;

  @IsString()
  @IsOptional()
  pageId: string;
}

export class SharePageIdDto {
  @IsString()
  @IsNotEmpty()
  pageId: string;
}
