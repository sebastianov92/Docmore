import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { AuthUser } from '../../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../../common/decorators/auth-workspace.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { NotionImportService } from './notion-import.service';

class NotionTokenDto {
  @IsString()
  @MinLength(20)
  @MaxLength(400)
  token: string;
}

class NotionLinkDto extends NotionTokenDto {
  @IsString()
  @MinLength(8)
  @MaxLength(2000)
  link: string;
}

class NotionRootDto {
  @IsString()
  @Matches(/^[0-9a-fA-F-]{32,36}$/)
  id: string;

  @IsIn(['page', 'database'])
  kind: 'page' | 'database';
}

class StartNotionImportDto extends NotionTokenDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => NotionRootDto)
  roots: NotionRootDto[];

  @IsUUID()
  spaceId: string;

  @IsOptional()
  @IsUUID()
  parentPageId?: string;
}

class NotionImportIdDto {
  @IsUUID()
  importId: string;
}

// Importing from Notion with the secret of a connection the person made
// there. The secret is used for the import and not stored.
@UseGuards(JwtAuthGuard)
@Controller('import/notion')
export class NotionImportController {
  constructor(private readonly imports: NotionImportService) {}

  @HttpCode(HttpStatus.OK)
  @Post('roots')
  roots(@Body() dto: NotionTokenDto) {
    return this.imports.roots(dto.token);
  }

  // A page or database by its link, for what the list does not show (yet).
  @HttpCode(HttpStatus.OK)
  @Post('resolve')
  resolve(@Body() dto: NotionLinkDto) {
    return this.imports.resolve(dto.token, dto.link);
  }

  @HttpCode(HttpStatus.OK)
  @Post('start')
  start(@Body() dto: StartNotionImportDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return this.imports.start(user, workspace, dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post('status')
  status(@Body() dto: NotionImportIdDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return this.imports.status(user, workspace, dto.importId);
  }
}
