import {
  ArrayNotEmpty,
  IsArray,
  IsDateString,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export const API_KEY_SCOPES = ['read', 'write'] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export class CreateApiKeyDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @IsDateString()
  expiresAt: string;

  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(API_KEY_SCOPES, { each: true })
  scopes?: ApiKeyScope[];
}
