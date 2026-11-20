import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { IsIn, IsObject, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { AuthUser } from '../../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../../common/decorators/auth-workspace.decorator';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { PageSuggestionService } from './page-suggestion.service';

class PageIdDto {
  @IsUUID()
  pageId: string;
}
class ListSuggestionsDto extends PageIdDto {
  @IsOptional()
  @IsIn(['open', 'accepted', 'rejected', 'withdrawn'])
  status?: string;
}
class CreateSuggestionDto extends PageIdDto {
  @IsObject()
  content: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  note?: string;
}
class SuggestionIdDto {
  @IsUUID()
  suggestionId: string;
}
class ReviewDto extends SuggestionIdDto {
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  reviewNote?: string;
}

@UseGuards(JwtAuthGuard)
@Controller('pages/suggestions')
export class PageSuggestionController {
  constructor(private readonly suggestions: PageSuggestionService) {}

  @HttpCode(HttpStatus.OK)
  @Post()
  async list(@Body() dto: ListSuggestionsDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return { items: await this.suggestions.list(user, workspace.id, dto.pageId, dto.status) };
  }

  @HttpCode(HttpStatus.OK)
  @Post('count')
  async count(@Body() dto: PageIdDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return this.suggestions.count(user, workspace.id, dto.pageId);
  }

  @HttpCode(HttpStatus.OK)
  @Post('info')
  async info(@Body() dto: SuggestionIdDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return this.suggestions.info(user, workspace.id, dto.suggestionId);
  }

  @HttpCode(HttpStatus.OK)
  @Post('create')
  async create(@Body() dto: CreateSuggestionDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return this.suggestions.create(user, workspace.id, dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post('accept')
  async accept(@Body() dto: ReviewDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return this.suggestions.accept(user, workspace.id, dto.suggestionId, dto.reviewNote);
  }

  @HttpCode(HttpStatus.OK)
  @Post('reject')
  async reject(@Body() dto: ReviewDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return this.suggestions.reject(user, workspace.id, dto.suggestionId, dto.reviewNote);
  }

  @HttpCode(HttpStatus.OK)
  @Post('withdraw')
  async withdraw(@Body() dto: SuggestionIdDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return this.suggestions.withdraw(user, workspace.id, dto.suggestionId);
  }
}
