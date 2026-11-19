import { IsOptional, IsString, IsUUID } from 'class-validator';

export class PageIdDto {
  @IsString()
  pageId: string;

  // comments of one row of a base; page comments otherwise
  @IsOptional()
  @IsUUID()
  baseRowId?: string;
}

export class CommentIdDto {
  @IsUUID()
  commentId: string;
}
