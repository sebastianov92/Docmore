import {
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
} from 'class-validator';
import { BASE_PROPERTY_ID_RE } from '../base-ids';
import {
  USER_PROPERTY_TYPES,
  BasePropertyTypeValue,
  PROPERTY_RESTRICTIONS,
  PropertyRestriction,
} from '../base.schemas';

export class UpdatePropertyDto {
  @Matches(BASE_PROPERTY_ID_RE)
  propertyId: string;

  @IsUUID()
  pageId: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsIn(USER_PROPERTY_TYPES)
  type?: BasePropertyTypeValue;

  @IsOptional()
  @IsObject()
  typeOptions?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  requestId?: string;

  // who may see the column (space admins set it)
  @IsOptional()
  @IsIn(PROPERTY_RESTRICTIONS)
  restrictedTo?: PropertyRestriction;
}

export class DeletePropertyDto {
  @Matches(BASE_PROPERTY_ID_RE)
  propertyId: string;

  @IsUUID()
  pageId: string;

  @IsOptional()
  @IsString()
  requestId?: string;
}

export class ReorderPropertyDto {
  @Matches(BASE_PROPERTY_ID_RE)
  propertyId: string;

  @IsUUID()
  pageId: string;

  @IsString()
  @IsNotEmpty()
  position: string;

  @IsOptional()
  @IsString()
  requestId?: string;
}
