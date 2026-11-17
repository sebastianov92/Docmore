import {
  IsBoolean,
  IsIn,
  IsISO8601,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';
import {
  ANNOUNCEMENT_AUDIENCES,
  ANNOUNCEMENT_COLORS,
  ANNOUNCEMENT_MAX_TITLE_LENGTH,
  ANNOUNCEMENT_STATUSES,
  ANNOUNCEMENT_TYPES,
} from '../announcement.constants';

export class ListAnnouncementsDto extends PaginationOptions {
  @IsOptional()
  @IsIn(ANNOUNCEMENT_STATUSES as unknown as string[])
  status?: string;
}

export class AnnouncementIdDto {
  @IsUUID()
  announcementId: string;
}

export class CreateAnnouncementDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(ANNOUNCEMENT_MAX_TITLE_LENGTH)
  title: string;

  @IsIn(ANNOUNCEMENT_TYPES as unknown as string[])
  type: string;

  @IsIn(ANNOUNCEMENT_COLORS as unknown as string[])
  color: string;

  // Checked by hand in the service: one paragraph of marked text.
  @IsObject()
  content: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  isDismissible?: boolean;

  @IsOptional()
  @IsIn(ANNOUNCEMENT_AUDIENCES as unknown as string[])
  audience?: string;

  // null or missing means now
  @IsOptional()
  @IsISO8601()
  startsAt?: string | null;

  // null or missing means no end
  @IsOptional()
  @IsISO8601()
  endsAt?: string | null;

  // Cut the announcements this one overlaps instead of refusing.
  @IsOptional()
  @IsBoolean()
  replace?: boolean;
}

export class UpdateAnnouncementDto extends CreateAnnouncementDto {
  @IsUUID()
  announcementId: string;
}
