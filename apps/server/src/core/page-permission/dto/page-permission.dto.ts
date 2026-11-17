import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsUUID,
  ValidateIf,
} from 'class-validator';
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';
import { PagePermissionRole } from '../../../common/helpers/types/permission';

export const PAGE_PERMISSION_ROLES = [
  PagePermissionRole.READER,
  PagePermissionRole.WRITER,
] as const;

export class PageIdDto {
  @IsUUID()
  pageId: string;
}

export class ListPagePermissionsDto extends PaginationOptions {
  @IsUUID()
  pageId: string;
}

export class AddPagePermissionDto {
  @IsUUID()
  pageId: string;

  @IsIn(PAGE_PERMISSION_ROLES)
  role: PagePermissionRole;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID(undefined, { each: true })
  userIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID(undefined, { each: true })
  groupIds?: string[];
}

export class UpdatePagePermissionDto {
  @IsUUID()
  pageId: string;

  @IsIn(PAGE_PERMISSION_ROLES)
  role: PagePermissionRole;

  @ValidateIf((o) => !o.groupId)
  @IsUUID()
  userId?: string;

  @ValidateIf((o) => !o.userId)
  @IsUUID()
  groupId?: string;
}

export class RemovePagePermissionDto {
  @IsUUID()
  pageId: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID(undefined, { each: true })
  userIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID(undefined, { each: true })
  groupIds?: string[];
}
