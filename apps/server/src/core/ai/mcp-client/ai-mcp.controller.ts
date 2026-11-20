import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { AuthUser } from '../../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../../common/decorators/auth-workspace.decorator';
import { RequireSessionAuth } from '../../../common/decorators/require-session-auth.decorator';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { AiMcpServerService } from './ai-mcp-server.service';
import { CreateMcpServerDto, McpServerIdDto, UpdateMcpServerDto } from './ai-mcp.dto';

// The MCP servers the chat may call: list, add, change, test, remove.
@UseGuards(JwtAuthGuard)
@Controller('ai/mcp-servers')
export class AiMcpController {
  constructor(private readonly servers: AiMcpServerService) {}

  @HttpCode(HttpStatus.OK)
  @Post()
  async list(@AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return { items: await this.servers.list(user, workspace) };
  }

  @HttpCode(HttpStatus.OK)
  @Post('create')
  @RequireSessionAuth()
  async create(@Body() dto: CreateMcpServerDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return this.servers.create(user, workspace, dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post('update')
  @RequireSessionAuth()
  async update(@Body() dto: UpdateMcpServerDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return this.servers.update(user, workspace, dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post('delete')
  @RequireSessionAuth()
  async remove(@Body() dto: McpServerIdDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    await this.servers.remove(user, workspace, dto.serverId);
    return {};
  }

  @HttpCode(HttpStatus.OK)
  @Post('test')
  @RequireSessionAuth()
  async test(@Body() dto: McpServerIdDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return this.servers.test(user, workspace, dto.serverId);
  }
}
