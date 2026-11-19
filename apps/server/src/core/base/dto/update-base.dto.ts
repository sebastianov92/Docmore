import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';

export class UpdateBaseDto {
  @IsUUID()
  pageId: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  icon?: string;

  // Structure lock: properties and views stop changing while true.
  @IsOptional()
  @IsBoolean()
  locked?: boolean;
}
