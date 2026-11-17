import {
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';
import { MAX_CHAT_MESSAGE_CHARS } from '../ai-chat.constants';

export class ChatIdDto {
  @IsUUID()
  chatId: string;
}

export class UpdateChatDto extends ChatIdDto {
  @IsString()
  @MaxLength(200)
  title: string;
}

export class SearchChatsDto {
  @IsString()
  @MaxLength(200)
  query: string;
}

export class ListChatsDto extends PaginationOptions {}

export class SendMessageDto {
  @IsOptional()
  @IsUUID()
  chatId?: string;

  @IsString()
  @MaxLength(MAX_CHAT_MESSAGE_CHARS)
  content: string;

  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  mentionedPageIds?: string[];

  // The page open beside the chat panel; its content goes in as context.
  @IsOptional()
  @IsUUID()
  contextPageId?: string;

  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  attachmentIds?: string[];
}
