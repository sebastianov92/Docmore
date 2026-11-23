import { Body, Controller, ForbiddenException, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength, ValidateIf, ValidateNested } from 'class-validator';
import { AuthUser } from '../../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../../common/decorators/auth-workspace.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { NotionImportService } from './notion-import.service';
import { NotionConnectionService } from './notion-connection.service';

// The secret of a Notion connection: pasted for this once, or the id of one
// the workspace keeps (Settings > Integrations).
class NotionTokenDto {
  @ValidateIf((dto: NotionTokenDto) => !dto.connectionId)
  @IsString()
  @MinLength(20)
  @MaxLength(400)
  token?: string;

  @IsOptional()
  @IsUUID()
  connectionId?: string;
}

class NotionLinkDto extends NotionTokenDto {
  @IsString()
  @MinLength(8)
  @MaxLength(2000)
  link: string;
}

class NewNotionConnectionDto {
  @IsString()
  @MinLength(20)
  @MaxLength(400)
  token: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  name?: string;
}

class NotionConnectionIdDto {
  @IsUUID()
  connectionId: string;
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
// there. A secret pasted for one import is used for it and not stored; a
// connection kept in Settings > Integrations is stored encrypted and used
// by its id.
@UseGuards(JwtAuthGuard)
@Controller('import/notion')
export class NotionImportController {
  constructor(
    private readonly imports: NotionImportService,
    private readonly connections: NotionConnectionService,
  ) {}

  private secret(dto: NotionTokenDto, user: User, workspace: Workspace): Promise<string> {
    if (dto.connectionId) return this.connections.secret(user, workspace, dto.connectionId);
    return Promise.resolve(String(dto.token ?? ''));
  }

  @HttpCode(HttpStatus.OK)
  @Post('connections')
  async listConnections(@AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return { items: await this.connections.list(user, workspace), canManage: this.connections.canManage(user, workspace) };
  }

  @HttpCode(HttpStatus.OK)
  @Post('connections/create')
  createConnection(@Body() dto: NewNotionConnectionDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return this.connections.create(user, workspace, dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post('connections/delete')
  async deleteConnection(@Body() dto: NotionConnectionIdDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    await this.connections.remove(user, workspace, dto.connectionId);
    return { success: true };
  }

  @HttpCode(HttpStatus.OK)
  @Post('roots')
  async roots(@Body() dto: NotionTokenDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return this.imports.roots(await this.secret(dto, user, workspace));
  }

  // A page or database by its link, for what the list does not show (yet).
  @HttpCode(HttpStatus.OK)
  @Post('resolve')
  async resolve(@Body() dto: NotionLinkDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return this.imports.resolve(await this.secret(dto, user, workspace), dto.link);
  }

  // What Notion says about one page or database, as it says it: its blocks
  // in outline, its databases, their columns and their views. For finding
  // out why something did not come over as expected. No rows, no text.
  @HttpCode(HttpStatus.OK)
  @Post('inspect')
  async inspect(@Body() dto: NotionLinkDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    if (!this.connections.canManage(user, workspace)) throw new ForbiddenException();
    return this.imports.inspect(await this.secret(dto, user, workspace), dto.link);
  }

  @HttpCode(HttpStatus.OK)
  @Post('start')
  async start(@Body() dto: StartNotionImportDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return this.imports.start(user, workspace, { ...dto, token: await this.secret(dto, user, workspace) });
  }

  @HttpCode(HttpStatus.OK)
  @Post('status')
  status(@Body() dto: NotionImportIdDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return this.imports.status(user, workspace, dto.importId);
  }
}
