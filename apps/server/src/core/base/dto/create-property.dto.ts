import {
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';
import {
  BASE_PROPERTY_TYPES,
  PROPERTY_RESTRICTIONS,
  PropertyRestriction,
} from '../base.schemas';

export class CreatePropertyDto {
  @IsUUID()
  pageId: string;

  @IsString()
  @IsNotEmpty()
  name: string;

  @IsIn(BASE_PROPERTY_TYPES)
  type: string;

  @IsOptional()
  @IsObject()
  typeOptions?: Record<string, unknown>;

  // who may see the column (space admins set it)
  @IsOptional()
  @IsIn(PROPERTY_RESTRICTIONS)
  restrictedTo?: PropertyRestriction;
}
