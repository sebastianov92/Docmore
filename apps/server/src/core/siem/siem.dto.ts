import { IsBoolean, IsIn, IsNotEmpty, IsObject, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export const SIEM_TYPES = ['webhook', 'splunk', 'elastic'] as const;

export class CreateSiemDestinationDto {
  @IsIn(SIEM_TYPES)
  type: (typeof SIEM_TYPES)[number];

  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name: string;

  // { url, index? }
  @IsObject()
  config: Record<string, unknown>;

  // { token? }
  @IsOptional()
  @IsObject()
  secrets?: Record<string, unknown>;
}

export class UpdateSiemDestinationDto {
  @IsUUID()
  destinationId: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  secrets?: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class SiemDestinationIdDto {
  @IsUUID()
  destinationId: string;
}
