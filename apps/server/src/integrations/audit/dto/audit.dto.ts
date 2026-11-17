import {
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  MAX_AUDIT_RETENTION_DAYS,
  MIN_AUDIT_RETENTION_DAYS,
} from '../audit.utils';

export class AuditListDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  event?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  resourceType?: string;

  @IsOptional()
  @IsUUID()
  actorId?: string;

  @IsOptional()
  @IsUUID()
  spaceId?: string;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @IsString()
  beforeCursor?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class UpdateAuditRetentionDto {
  @IsInt()
  @Min(MIN_AUDIT_RETENTION_DAYS)
  @Max(MAX_AUDIT_RETENTION_DAYS)
  auditRetentionDays: number;
}
