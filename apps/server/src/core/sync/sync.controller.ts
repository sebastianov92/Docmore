import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { SyncService } from './sync.service';
import { ClientBundleService } from './client-bundle.service';
import { DeviceDto, SetOfflinePinsDto, SyncDocsDto, SyncPullDto, SyncSpacePagesDto } from './sync.dto';

@UseGuards(JwtAuthGuard)
@Controller('sync')
export class SyncController {
  constructor(
    private readonly sync: SyncService,
    private readonly bundle: ClientBundleService,
  ) {}

  // What a desktop app asks before anything else: is this a Docmore server
  // that can sync, and which web client does it serve.
  @Public()
  @Get('info')
  async info() {
    const manifest = await this.bundle.getManifest();
    return {
      app: 'docmore',
      version: manifest.version,
      clientHash: manifest.hash,
      sync: 1,
    };
  }

  // The served web client, file by file. Each file is fetched from its usual
  // URL (/<path>), so this is as public as the files themselves.
  @Public()
  @Get('client-bundle')
  async clientBundle() {
    return this.bundle.getManifest();
  }

  @HttpCode(HttpStatus.OK)
  @Post('snapshot')
  async snapshot(@AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return this.sync.snapshot(user, workspace);
  }

  @HttpCode(HttpStatus.OK)
  @Post('space-pages')
  async spacePages(@Body() dto: SyncSpacePagesDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return this.sync.spacePages(user, workspace, dto.spaceId, dto.after, dto.limit);
  }

  @HttpCode(HttpStatus.OK)
  @Post('pull')
  async pull(@Body() dto: SyncPullDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return this.sync.pull(user, workspace, dto.cursor, dto.limit);
  }

  @HttpCode(HttpStatus.OK)
  @Post('docs')
  async docs(@Body() dto: SyncDocsDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return { docs: await this.sync.syncDocs(user, workspace, dto.docs) };
  }

  @HttpCode(HttpStatus.OK)
  @Post('pins')
  async pins(@Body() dto: DeviceDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return this.sync.listPins(user, workspace, dto.deviceId);
  }

  @HttpCode(HttpStatus.OK)
  @Post('pins/set')
  async setPins(@Body() dto: SetOfflinePinsDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return this.sync.setPins(user, workspace, dto.deviceId, dto.deviceName, dto.pins);
  }
}
