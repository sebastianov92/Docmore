import { Body, Controller, ForbiddenException, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { UserRole } from '../../common/helpers/types/permission';
import { SiemService } from './siem.service';
import { CreateSiemDestinationDto, SiemDestinationIdDto, UpdateSiemDestinationDto, SIEM_TYPES } from './siem.dto';

// Owners only: the audit trail leaves the server here.
@UseGuards(JwtAuthGuard)
@Controller('siem/destinations')
export class SiemController {
  constructor(private readonly siem: SiemService) {}

  private assertOwner(user: User) {
    if (user.role !== UserRole.OWNER) throw new ForbiddenException('Only the workspace owner manages SIEM destinations');
  }

  @HttpCode(HttpStatus.OK)
  @Post()
  async list(@AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    this.assertOwner(user);
    return { items: await this.siem.list(workspace.id), types: SIEM_TYPES };
  }

  @HttpCode(HttpStatus.OK)
  @Post('create')
  async create(@Body() dto: CreateSiemDestinationDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    this.assertOwner(user);
    return this.siem.create(workspace.id, user.id, dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post('update')
  async update(@Body() dto: UpdateSiemDestinationDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    this.assertOwner(user);
    return this.siem.update(workspace.id, dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post('delete')
  async delete(@Body() dto: SiemDestinationIdDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    this.assertOwner(user);
    await this.siem.delete(workspace.id, dto.destinationId);
  }

  @HttpCode(HttpStatus.OK)
  @Post('test')
  async test(@Body() dto: SiemDestinationIdDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    this.assertOwner(user);
    return this.siem.test(workspace.id, dto.destinationId);
  }

  @HttpCode(HttpStatus.OK)
  @Post('run')
  async run(@Body() dto: SiemDestinationIdDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    this.assertOwner(user);
    return this.siem.runNow(workspace.id, dto.destinationId);
  }
}
