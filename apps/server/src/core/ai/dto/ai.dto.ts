import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import {
  AI_ACTIONS,
  AI_PROVIDERS,
  MAX_INPUT_CHARS,
  MAX_PROMPT_CHARS,
  MAX_QUESTION_CHARS,
} from '../ai.constants';

export class ProviderPatchDto {
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  apiKey?: string;

  @IsOptional()
  @IsBoolean()
  clearApiKey?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  baseUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;
}

export class ModelChoiceDto {
  @IsIn(AI_PROVIDERS as unknown as string[])
  provider: string;

  @IsString()
  @MaxLength(200)
  model: string;
}

export class UpdateAiSettingsDto {
  // Keyed by provider id; validated by hand in the service.
  @IsOptional()
  @IsObject()
  providers?: Record<string, ProviderPatchDto>;

  @IsOptional()
  @ValidateNested()
  @Type(() => ModelChoiceDto)
  generation?: ModelChoiceDto | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => ModelChoiceDto)
  embedding?: ModelChoiceDto | null;

  // Per-person limits; validated by hand in the service.
  @IsOptional()
  @IsObject()
  limits?: Record<string, unknown>;
}

export class ListModelsDto {
  @IsIn(AI_PROVIDERS as unknown as string[])
  provider: string;

  // Try credentials before saving them.
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  apiKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  baseUrl?: string;
}

export class AskDto {
  @IsString()
  @MaxLength(MAX_QUESTION_CHARS)
  query: string;

  @IsOptional()
  @IsUUID()
  spaceId?: string;

  @IsOptional()
  @IsBoolean()
  includeArchived?: boolean;
}

export class GenerateDto {
  @IsIn(AI_ACTIONS as unknown as string[])
  action: string;

  @IsString()
  @MaxLength(MAX_INPUT_CHARS)
  content: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_PROMPT_CHARS)
  prompt?: string;
}
