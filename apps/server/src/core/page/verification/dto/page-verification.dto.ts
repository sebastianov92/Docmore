import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { MAX_VERIFIERS } from '../page-verification.utils';

export class VerificationPageIdDto {
  @IsUUID()
  pageId: string;
}

export class SetupVerificationDto extends VerificationPageIdDto {
  @IsIn(['expiring', 'qms'])
  type: 'expiring' | 'qms';

  @IsOptional()
  @IsIn(['period', 'fixed', 'indefinite'])
  mode?: 'period' | 'fixed' | 'indefinite';

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3650)
  periodAmount?: number;

  @IsOptional()
  @IsIn(['day', 'week', 'month', 'year'])
  periodUnit?: 'day' | 'week' | 'month' | 'year';

  @IsOptional()
  @IsDateString()
  fixedExpiresAt?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_VERIFIERS)
  @IsUUID('all', { each: true })
  verifierIds: string[];
}

export class UpdateVerificationDto extends VerificationPageIdDto {
  @IsOptional()
  @IsIn(['period', 'fixed', 'indefinite'])
  mode?: 'period' | 'fixed' | 'indefinite';

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3650)
  periodAmount?: number;

  @IsOptional()
  @IsIn(['day', 'week', 'month', 'year'])
  periodUnit?: 'day' | 'week' | 'month' | 'year';

  @IsOptional()
  @IsDateString()
  fixedExpiresAt?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_VERIFIERS)
  @IsUUID('all', { each: true })
  verifierIds?: string[];
}

export class RejectApprovalDto extends VerificationPageIdDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  comment?: string;
}

export class VerificationListDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('all', { each: true })
  spaceIds?: string[];

  @IsOptional()
  @IsUUID()
  verifierId?: string;

  @IsOptional()
  @IsIn(['expiring', 'qms'])
  type?: 'expiring' | 'qms';

  @IsOptional()
  @IsString()
  @MaxLength(200)
  query?: string;

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
