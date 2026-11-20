import { IsBoolean, IsIn, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class CreateSkillDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  @IsString()
  @MaxLength(20_000)
  instructions: string;

  @IsIn(['workspace', 'personal'])
  scope: 'workspace' | 'personal';
}

export class UpdateSkillDto {
  @IsUUID()
  skillId: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(20_000)
  instructions?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsIn(['workspace', 'personal'])
  scope?: 'workspace' | 'personal';
}

export class SkillIdDto {
  @IsUUID()
  skillId: string;
}

export class ListSkillsDto {
  @IsOptional()
  @IsBoolean()
  enabledOnly?: boolean;
}
