import { IsBoolean, IsOptional, IsString, IsUUID } from 'class-validator';

export class ResolveCommentDto {
  @IsUUID()
  commentId: string;

  @IsBoolean()
  resolved: boolean;

  // Sent by the client for cache bookkeeping; the server trusts the comment row.
  @IsOptional()
  @IsString()
  pageId?: string;
}
