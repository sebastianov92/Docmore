import { OmitType, PartialType } from '@nestjs/mapped-types';
import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  IsArray,
  ArrayMaxSize,
} from 'class-validator';
import { CreateUserDto } from '../../auth/dto/create-user.dto';

export class UpdateUserDto extends PartialType(
  OmitType(CreateUserDto, ['password'] as const),
) {
  @IsOptional()
  @IsBoolean()
  fullPageWidth: boolean;

  @IsOptional()
  @IsString()
  @IsIn(['read', 'edit'])
  pageEditMode: string;

  @IsOptional()
  @IsBoolean()
  editorToolbar: boolean;

  // Reading preferences: typeface and text size of pages, high contrast UI.
  @IsOptional()
  @IsString()
  @IsIn(['default', 'serif', 'mono'])
  pageFont: string;

  @IsOptional()
  @IsString()
  @IsIn(['small', 'normal', 'large'])
  pageTextSize: string;

  @IsOptional()
  @IsBoolean()
  highContrast: boolean;

  // Home widgets shown, in order; sidebar shortcuts (pages or links).
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(12)
  homeWidgets: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  shortcuts: Record<string, unknown>[];

  @IsOptional()
  @IsString()
  locale: string;

  @IsOptional()
  @MinLength(8)
  @MaxLength(70)
  @IsString()
  confirmPassword: string;

  @IsOptional()
  @IsBoolean()
  notificationPageUpdates: boolean;

  @IsOptional()
  @IsBoolean()
  notificationPageUserMention: boolean;

  @IsOptional()
  @IsBoolean()
  notificationCommentUserMention: boolean;

  @IsOptional()
  @IsBoolean()
  notificationCommentCreated: boolean;

  @IsOptional()
  @IsBoolean()
  notificationCommentResolved: boolean;
}
