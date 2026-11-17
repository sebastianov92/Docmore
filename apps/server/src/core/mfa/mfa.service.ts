import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import * as OTPAuth from 'otpauth';
import * as QRCode from 'qrcode';
import { UserMfaRepo, UserMfaRow } from '@docmost/db/repos/mfa/user-mfa.repo';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { UserSessionRepo } from '@docmost/db/repos/session/user-session.repo';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { TokenService } from '../auth/services/token.service';
import { AuthService } from '../auth/services/auth.service';
import { LoginDto } from '../auth/dto/login.dto';
import { JwtType } from '../auth/dto/jwt-payload';
import {
  EncryptionPurpose,
  EncryptionService,
} from '../../integrations/encryption/encryption.service';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import {
  comparePasswordHash,
  extractBearerTokenFromHeader,
  isUserDisabled,
} from '../../common/helpers';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../integrations/audit/audit.service';
import {
  consumeBackupCode,
  generateBackupCodes,
  hashBackupCode,
  looksLikeTotpCode,
} from './mfa.codes';

const TOTP_ISSUER_FALLBACK = 'Docmore';
const MFA_TOKEN_TTL_MS = 5 * 60 * 1000;

export type MfaActor = {
  user: User;
  workspace: Workspace;
  viaMfaToken: boolean;
};

export type MfaLoginResult = {
  userHasMfa: boolean;
  requiresMfaSetup: boolean;
  isMfaEnforced: boolean;
  authToken?: string;
};

@Injectable()
export class MfaService {
  private readonly logger = new Logger(MfaService.name);

  constructor(
    private readonly userMfaRepo: UserMfaRepo,
    private readonly userRepo: UserRepo,
    private readonly workspaceRepo: WorkspaceRepo,
    private readonly userSessionRepo: UserSessionRepo,
    private readonly tokenService: TokenService,
    private readonly authService: AuthService,
    private readonly encryptionService: EncryptionService,
    private readonly environmentService: EnvironmentService,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
  ) {}

  async getStatus(user: User, workspace: Workspace) {
    const row = await this.userMfaRepo.findByUserId(user.id, workspace.id);
    const isEnabled = row?.isEnabled === true;
    return {
      isEnabled,
      method: isEnabled ? row.method : null,
      backupCodesCount: isEnabled ? (row.backupCodes?.length ?? 0) : 0,
    };
  }

  async setup(user: User, workspace: Workspace) {
    const existing = await this.userMfaRepo.findByUserId(user.id, workspace.id);
    if (existing?.isEnabled) {
      throw new BadRequestException(
        'Two-factor authentication is already enabled',
      );
    }

    const secret = new OTPAuth.Secret({ size: 20 });
    const totp = this.buildTotp(secret.base32, user, workspace);

    await this.userMfaRepo.upsert({
      userId: user.id,
      workspaceId: workspace.id,
      method: 'totp',
      secret: this.encryptionService.encrypt(
        secret.base32,
        EncryptionPurpose.MFA_SECRETS,
      ),
      isEnabled: false,
      backupCodes: null,
    });

    const qrCode = await QRCode.toDataURL(totp.toString(), {
      margin: 1,
      width: 240,
    });

    return { method: 'totp', qrCode, manualKey: secret.base32 };
  }

  async enable(user: User, workspace: Workspace, verificationCode: string) {
    const row = await this.userMfaRepo.findByUserId(user.id, workspace.id);
    if (!row?.secret) {
      throw new BadRequestException('Start the two-factor setup first');
    }
    if (row.isEnabled) {
      throw new BadRequestException(
        'Two-factor authentication is already enabled',
      );
    }

    if (!this.verifyTotp(row, user, workspace, verificationCode)) {
      throw new UnauthorizedException('Invalid verification code');
    }

    const backupCodes = generateBackupCodes();
    await this.userMfaRepo.update(user.id, workspace.id, {
      isEnabled: true,
      backupCodes: backupCodes.map((code) => this.hashCode(code)),
    });

    this.auditService.setActorId(user.id);
    this.auditService.log({
      event: AuditEvent.USER_MFA_ENABLED,
      resourceType: AuditResource.USER,
      resourceId: user.id,
      metadata: { method: 'totp' },
    });

    return { success: true, backupCodes };
  }

  async disable(user: User, workspace: Workspace, confirmPassword?: string) {
    if (workspace.enforceMfa) {
      throw new ForbiddenException(
        'Your workspace requires two-factor authentication',
      );
    }

    const row = await this.userMfaRepo.findByUserId(user.id, workspace.id);
    if (!row?.isEnabled) {
      throw new BadRequestException('Two-factor authentication is not enabled');
    }

    await this.assertPassword(user, workspace, confirmPassword);
    await this.userMfaRepo.deleteByUserId(user.id, workspace.id);

    this.auditService.log({
      event: AuditEvent.USER_MFA_DISABLED,
      resourceType: AuditResource.USER,
      resourceId: user.id,
    });

    return { success: true };
  }

  async regenerateBackupCodes(
    user: User,
    workspace: Workspace,
    confirmPassword?: string,
  ) {
    const row = await this.userMfaRepo.findByUserId(user.id, workspace.id);
    if (!row?.isEnabled) {
      throw new BadRequestException('Two-factor authentication is not enabled');
    }

    await this.assertPassword(user, workspace, confirmPassword);

    const backupCodes = generateBackupCodes();
    await this.userMfaRepo.update(user.id, workspace.id, {
      backupCodes: backupCodes.map((code) => this.hashCode(code)),
    });

    this.auditService.log({
      event: AuditEvent.USER_MFA_BACKUP_CODE_GENERATED,
      resourceType: AuditResource.USER,
      resourceId: user.id,
    });

    return { backupCodes };
  }

  // Password login, step one. Either finishes the login or parks the user behind
  // a short-lived MFA token in the auth cookie until they pass the challenge.
  async checkMfaRequirements(
    loginDto: LoginDto,
    workspace: Workspace,
    res: FastifyReply,
  ): Promise<MfaLoginResult> {
    const user = await this.authService.authenticate(loginDto, workspace.id);

    const row = await this.userMfaRepo.findByUserId(user.id, workspace.id);
    const userHasMfa = row?.isEnabled === true;
    const isMfaEnforced = workspace.enforceMfa === true;

    if (userHasMfa || isMfaEnforced) {
      const mfaToken = await this.tokenService.generateMfaToken(
        user,
        workspace.id,
      );
      this.setAuthCookie(res, mfaToken, new Date(Date.now() + MFA_TOKEN_TTL_MS));
      return {
        userHasMfa,
        requiresMfaSetup: !userHasMfa && isMfaEnforced,
        isMfaEnforced,
      };
    }

    const authToken = await this.authService.completeLogin(user, workspace.id);
    return {
      userHasMfa: false,
      requiresMfaSetup: false,
      isMfaEnforced: false,
      authToken,
    };
  }

  // Step two: a TOTP or backup code turns the MFA token into a real session.
  async verify(
    req: FastifyRequest,
    res: FastifyReply,
    workspace: Workspace,
    code: string,
  ) {
    const { user } = await this.resolveMfaToken(req, workspace);

    const row = await this.userMfaRepo.findByUserId(user.id, workspace.id);
    if (!row?.isEnabled) {
      throw new BadRequestException('Two-factor authentication is not enabled');
    }

    const accepted = looksLikeTotpCode(code)
      ? this.verifyTotp(row, user, workspace, code.trim())
      : await this.redeemBackupCode(row, user, workspace, code);

    if (!accepted) {
      throw new UnauthorizedException('Invalid verification code');
    }

    const authToken = await this.authService.completeLogin(
      user,
      workspace.id,
      'password+mfa',
    );
    this.setAuthCookie(res, authToken);
    return { success: true };
  }

  // Tells the MFA pages whether the cookie holds a session, an MFA token, or nothing.
  async validateAccess(req: FastifyRequest, workspace: Workspace) {
    const token = this.readToken(req);
    if (!token) {
      return { valid: false };
    }

    try {
      await this.tokenService.verifyJwt(token, JwtType.ACCESS);
      return { valid: true, isTransferToken: false };
    } catch {
      // not a session token, try the MFA transfer token below
    }

    try {
      const { user } = await this.resolveMfaToken(req, workspace);
      const row = await this.userMfaRepo.findByUserId(user.id, workspace.id);
      const userHasMfa = row?.isEnabled === true;
      const isMfaEnforced = workspace.enforceMfa === true;
      return {
        valid: true,
        isTransferToken: true,
        userHasMfa,
        requiresMfaSetup: !userHasMfa && isMfaEnforced,
        isMfaEnforced,
      };
    } catch {
      return { valid: false };
    }
  }

  // Setup and enable work both for a logged-in user and for one who is still
  // behind the MFA token because the workspace enforces 2FA.
  async resolveActor(req: FastifyRequest, workspace: Workspace): Promise<MfaActor> {
    const token = this.readToken(req);
    if (!token) {
      throw new UnauthorizedException();
    }

    try {
      const payload = await this.tokenService.verifyJwt(token, JwtType.ACCESS);
      if (payload.workspaceId !== workspace.id) {
        throw new UnauthorizedException();
      }
      if (payload.sessionId) {
        const session = await this.userSessionRepo.findActiveById(
          payload.sessionId,
        );
        if (!session || session.userId !== payload.sub) {
          throw new UnauthorizedException();
        }
      }
      const user = await this.loadUser(payload.sub, workspace.id);
      return { user, workspace, viaMfaToken: false };
    } catch {
      // fall through to the MFA token
    }

    const { user } = await this.resolveMfaToken(req, workspace);
    return { user, workspace, viaMfaToken: true };
  }

  async completeLoginAfterSetup(user: User, workspace: Workspace, res: FastifyReply) {
    const authToken = await this.authService.completeLogin(
      user,
      workspace.id,
      'password+mfa',
    );
    this.setAuthCookie(res, authToken);
  }

  private async resolveMfaToken(req: FastifyRequest, workspace: Workspace) {
    const token = this.readToken(req);
    if (!token) {
      throw new UnauthorizedException('Please log in again');
    }

    let payload: { sub: string; workspaceId: string };
    try {
      payload = await this.tokenService.verifyJwt(token, JwtType.MFA_TOKEN);
    } catch {
      throw new UnauthorizedException('Your login expired, please log in again');
    }

    if (payload.workspaceId !== workspace.id) {
      throw new UnauthorizedException();
    }

    const user = await this.loadUser(payload.sub, workspace.id);
    return { user, payload };
  }

  private async loadUser(userId: string, workspaceId: string): Promise<User> {
    const user = await this.userRepo.findById(userId, workspaceId);
    if (!user || isUserDisabled(user)) {
      throw new UnauthorizedException();
    }
    return user;
  }

  private async assertPassword(
    user: User,
    workspace: Workspace,
    confirmPassword?: string,
  ) {
    const full = await this.userRepo.findById(user.id, workspace.id, {
      includePassword: true,
    });

    // SSO-created accounts carry a random password nobody knows; skip the check.
    if (full?.hasGeneratedPassword) {
      return;
    }

    if (!confirmPassword) {
      throw new BadRequestException('Password is required');
    }

    const matches = await comparePasswordHash(confirmPassword, full.password);
    if (!matches) {
      throw new UnauthorizedException('Incorrect password');
    }
  }

  private verifyTotp(
    row: UserMfaRow,
    user: User,
    workspace: Workspace,
    code: string,
  ): boolean {
    let base32: string;
    try {
      base32 = this.encryptionService.decrypt(
        row.secret,
        EncryptionPurpose.MFA_SECRETS,
      );
    } catch (err) {
      this.logger.error(`cannot decrypt MFA secret for user ${user.id}`, err);
      return false;
    }

    const totp = this.buildTotp(base32, user, workspace);
    return totp.validate({ token: code, window: 1 }) !== null;
  }

  private async redeemBackupCode(
    row: UserMfaRow,
    user: User,
    workspace: Workspace,
    code: string,
  ): Promise<boolean> {
    const remaining = consumeBackupCode(
      row.backupCodes ?? [],
      code,
      this.environmentService.getAppSecret(),
    );
    if (remaining === null) {
      return false;
    }
    await this.userMfaRepo.update(user.id, workspace.id, {
      backupCodes: remaining,
    });
    return true;
  }

  private buildTotp(base32: string, user: User, workspace: Workspace) {
    return new OTPAuth.TOTP({
      issuer: workspace.name?.trim() || TOTP_ISSUER_FALLBACK,
      label: user.email,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(base32),
    });
  }

  private hashCode(code: string): string {
    return hashBackupCode(code, this.environmentService.getAppSecret());
  }

  private readToken(req: FastifyRequest): string | undefined {
    return (req as any).cookies?.authToken || extractBearerTokenFromHeader(req);
  }

  private setAuthCookie(res: FastifyReply, token: string, expires?: Date) {
    res.setCookie('authToken', token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      expires: expires ?? this.environmentService.getCookieExpiresIn(),
      secure: this.environmentService.isHttps(),
    });
  }
}
