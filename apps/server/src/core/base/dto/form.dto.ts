import { IsArray, IsBoolean, IsNotEmpty, IsObject, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class ListFormsDto {
  @IsUUID()
  pageId: string;
}

export class CreateFormDto {
  @IsUUID()
  pageId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsArray()
  fields: Record<string, unknown>[];

  @IsOptional()
  @IsString()
  @MaxLength(60)
  submitLabel?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  thanksText?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class UpdateFormDto {
  @IsUUID()
  pageId: string;

  @IsUUID()
  formId: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsArray()
  fields?: Record<string, unknown>[];

  @IsOptional()
  @IsString()
  @MaxLength(60)
  submitLabel?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  thanksText?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class FormIdDto {
  @IsUUID()
  pageId: string;

  @IsUUID()
  formId: string;
}

export class FormTokenDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  token: string;
}

export class SubmitFormDto extends FormTokenDto {
  @IsObject()
  cells: Record<string, unknown>;

  // honeypot: real people leave it empty
  @IsOptional()
  @IsString()
  website?: string;
}
