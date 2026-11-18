import { IsIn, IsOptional, IsUUID } from 'class-validator';
import { BASE_TEMPLATES, BaseTemplate } from './create-base.dto';

export class ConvertBaseDto {
  @IsUUID()
  pageId: string;

  @IsIn(BASE_TEMPLATES)
  @IsOptional()
  template?: BaseTemplate;
}
