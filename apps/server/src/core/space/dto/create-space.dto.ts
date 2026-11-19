import {
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import {Transform, TransformFnParams} from "class-transformer";

export class CreateSpaceDto {
  @MinLength(2)
  @MaxLength(100)
  @IsString()
  @Transform(({ value }: TransformFnParams) => value?.trim())
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  // open: anyone joins · closed: listed, join by request · private: hidden
  @IsOptional()
  @IsIn(['open', 'closed', 'private'])
  visibility?: string;

  @MinLength(2)
  @MaxLength(100)
  @Matches(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, {
    message:
      'Space slug must start with a letter or number and may contain hyphens and underscores',
  })
  slug: string;
}
