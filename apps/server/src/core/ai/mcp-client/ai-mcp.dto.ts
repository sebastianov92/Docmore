import { IsArray, IsBoolean, IsIn, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class CreateMcpServerDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name: string;

  @IsString()
  @MaxLength(2000)
  url: string;

  @IsIn(['workspace', 'personal'])
  scope: 'workspace' | 'personal';

  @IsOptional()
  @IsString()
  @MaxLength(80)
  authHeader?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  authValue?: string;

  @IsOptional()
  @IsBoolean()
  requireConfirmation?: boolean;
}

export class UpdateMcpServerDto {
  @IsUUID()
  serverId: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  url?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  authHeader?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  authValue?: string;

  @IsOptional()
  @IsBoolean()
  clearAuth?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allowedTools?: string[] | null;

  @IsOptional()
  @IsBoolean()
  requireConfirmation?: boolean;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class McpServerIdDto {
  @IsUUID()
  serverId: string;
}

export class ToolApprovalDto {
  @IsUUID()
  approvalId: string;
}
