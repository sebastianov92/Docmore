import { IsEnum, IsNotEmpty, IsUUID, IsOptional, ValidateIf, IsArray, IsIn } from 'class-validator';
import { ADMIN_SCOPES, UserRole } from '../../../common/helpers/types/permission';

export class UpdateWorkspaceUserRoleDto {
  @IsNotEmpty()
  @IsUUID()
  userId: string;

  @IsNotEmpty()
  @IsEnum(UserRole)
  role: string;

  // for admins: what they manage; null means everything (owner only)
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsArray()
  @IsIn(ADMIN_SCOPES as unknown as string[], { each: true })
  adminScopes?: string[] | null;
}
