import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle, ThrottlerGuard } from '@nestjs/throttler';
import { FastifyReply, FastifyRequest } from 'fastify';
import {
  ALL_NAMED_THROTTLERS_SKIPPED,
  AUTH_THROTTLER,
} from '../../integrations/throttle/throttler-names';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RequireSessionAuth } from '../../common/decorators/require-session-auth.decorator';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { MfaService } from './mfa.service';
import {
  ConfirmPasswordDto,
  EnableMfaDto,
  SetupMfaDto,
  VerifyMfaDto,
} from './dto/mfa.dto';

// Codes are guessable by brute force, so the whole controller shares the login throttler.
@SkipThrottle({ ...ALL_NAMED_THROTTLERS_SKIPPED, [AUTH_THROTTLER]: false })
@UseGuards(ThrottlerGuard)
@Controller('mfa')
export class MfaController {
  constructor(private readonly mfaService: MfaService) {}

  @UseGuards(JwtAuthGuard)
  @RequireSessionAuth()
  @HttpCode(HttpStatus.OK)
  @Post('status')
  async status(@AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return this.mfaService.getStatus(user, workspace);
  }

  @HttpCode(HttpStatus.OK)
  @Post('setup')
  async setup(
    @Req() req: FastifyRequest,
    @Body() _dto: SetupMfaDto,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const actor = await this.mfaService.resolveActor(req, workspace);
    return this.mfaService.setup(actor.user, workspace);
  }

  @HttpCode(HttpStatus.OK)
  @Post('enable')
  async enable(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
    @Body() dto: EnableMfaDto,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const actor = await this.mfaService.resolveActor(req, workspace);
    const result = await this.mfaService.enable(
      actor.user,
      workspace,
      dto.verificationCode,
    );

    // Enforced setup during login: the user proved the code, so finish the login.
    if (actor.viaMfaToken) {
      await this.mfaService.completeLoginAfterSetup(actor.user, workspace, res);
      return { ...result, loggedIn: true };
    }

    return result;
  }

  @UseGuards(JwtAuthGuard)
  @RequireSessionAuth()
  @HttpCode(HttpStatus.OK)
  @Post('disable')
  async disable(
    @Body() dto: ConfirmPasswordDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.mfaService.disable(user, workspace, dto.confirmPassword);
  }

  @UseGuards(JwtAuthGuard)
  @RequireSessionAuth()
  @HttpCode(HttpStatus.OK)
  @Post('generate-backup-codes')
  async generateBackupCodes(
    @Body() dto: ConfirmPasswordDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.mfaService.regenerateBackupCodes(
      user,
      workspace,
      dto.confirmPassword,
    );
  }

  @HttpCode(HttpStatus.OK)
  @Post('verify')
  async verify(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
    @Body() dto: VerifyMfaDto,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.mfaService.verify(req, res, workspace, dto.code);
  }

  @HttpCode(HttpStatus.OK)
  @Post('validate-access')
  async validateAccess(
    @Req() req: FastifyRequest,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.mfaService.validateAccess(req, workspace);
  }
}
