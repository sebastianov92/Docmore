import { IsArray, IsBoolean, IsInt, IsNotEmpty, IsObject, IsOptional, IsString, IsUUID, Max, Min, ValidateIf } from 'class-validator';
import { Type } from 'class-transformer';

export class ListAutomationsDto {
  @IsUUID()
  pageId: string;
}

export class CreateAutomationDto {
  @IsUUID()
  pageId: string;

  @IsString()
  @IsNotEmpty()
  name: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsObject()
  trigger: Record<string, unknown>;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsObject()
  conditions?: Record<string, unknown> | null;

  @IsArray()
  actions: Record<string, unknown>[];
}

export class UpdateAutomationDto {
  @IsUUID()
  pageId: string;

  @IsUUID()
  automationId: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsObject()
  trigger?: Record<string, unknown>;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsObject()
  conditions?: Record<string, unknown> | null;

  @IsOptional()
  @IsArray()
  actions?: Record<string, unknown>[];
}

export class AutomationIdDto {
  @IsUUID()
  pageId: string;

  @IsUUID()
  automationId: string;
}

export class RunAutomationDto extends AutomationIdDto {
  @IsOptional()
  @IsUUID()
  rowId?: string;
}

export class ListRunsDto extends AutomationIdDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
