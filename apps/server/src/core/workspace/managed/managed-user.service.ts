import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { UserTokenRepo } from '@docmost/db/repos/user-token/user-token.repo';
import { UserSessionRepo } from '@docmost/db/repos/session/user-session.repo';
import { executeTx } from '@docmost/db/utils';
import { hashPassword } from '../../../common/helpers/utils';
import { nanoIdGen } from '../../../common/helpers/nanoid.utils';
import { UserRole } from '../../../common/helpers/types/permission';
import { MailService } from '../../../integrations/mail/mail.service';
import { DomainService } from '../../../integrations/environment/domain.service';
import ForgotPasswordEmail from '@docmost/transactional/emails/forgot-password-email';
import { AUDIT_SERVICE, IAuditService } from '../../../integrations/audit/audit.service';
import { AuditEvent, AuditResource } from '../../../common/events/audit-events';
import { UserTokenType } from '../../auth/auth.constants';
import { WsService } from '../../../ws/ws.service';
import WorkspaceAbilityFactory from '../../casl/abilities/workspace-ability.factory';
import { WorkspaceCaslAction, WorkspaceCaslSubject } from '../../casl/interfaces/workspace-ability.type';

// Managed users: what an admin does to someone else's account - fix the
// name or email, sign them out everywhere, send or set a password, or
// allow only single sign-on. Owners are touched only by owners.
@Injectable()
export class ManagedUserService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly userRepo: UserRepo,
    private readonly userTokenRepo: UserTokenRepo,
    private readonly sessions: UserSessionRepo,
    private readonly mail: MailService,
    private readonly domain: DomainService,
    private readonly ws: WsService,
    private readonly workspaceAbility: WorkspaceAbilityFactory,
    @Inject(AUDIT_SERVICE) private readonly audit: IAuditService,
  ) {}

  async updateProfile(auth: User, workspace: Workspace, input: { userId: string; name?: string; email?: string }) {
    const target = await this.target(auth, workspace, input.userId);
    const patch: Record<string, unknown> = {};
    const before: Record<string, unknown> = {};
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) throw new BadRequestException('Name cannot be empty');
      before.name = target.name;
      patch.name = name.slice(0, 120);
    }
    if (input.email !== undefined) {
      const email = input.email.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new BadRequestException('Invalid email');
      if (email !== target.email.toLowerCase()) {
        const taken = await this.userRepo.findByEmail(email, workspace.id);
        if (taken) throw new BadRequestException('That email is already used by another member');
        before.email = target.email;
        patch.email = email;
      }
    }
    if (Object.keys(patch).length === 0) return this.userRepo.findById(target.id, workspace.id);
    await this.userRepo.updateUser(patch as any, target.id, workspace.id);
    this.audit.log({ event: AuditEvent.USER_UPDATED, resourceType: AuditResource.USER, resourceId: target.id, changes: { before, after: patch }, metadata: { byAdmin: true } } as any);
    return this.userRepo.findById(target.id, workspace.id);
  }

  async signOut(auth: User, workspace: Workspace, userId: string) {
    const target = await this.target(auth, workspace, userId);
    await this.sessions.revokeByUserId(target.id, workspace.id);
    this.ws.disconnectUser(target.id);
    this.audit.log({ event: AuditEvent.USER_SIGNED_OUT_BY_ADMIN, resourceType: AuditResource.USER, resourceId: target.id } as any);
    return { ok: true };
  }

  // A reset link by email; owners also get the link back for when mail is
  // not set up on this server.
  async resetPassword(auth: User, workspace: Workspace, userId: string) {
    const target = await this.target(auth, workspace, userId);
    if ((target as any).passwordLoginLocked) throw new BadRequestException('Password sign-in is turned off for this account');
    const token = nanoIdGen(16);
    await executeTx(this.db, async (trx) => {
      await trx.deleteFrom('userTokens').where('userId', '=', target.id).where('type', '=', UserTokenType.FORGOT_PASSWORD).execute();
      await this.userTokenRepo.insertUserToken(
        { token, userId: target.id, workspaceId: workspace.id, expiresAt: new Date(Date.now() + 30 * 60 * 1000), type: UserTokenType.FORGOT_PASSWORD },
        { trx },
      );
    });
    const link = `${this.domain.getUrl(workspace.hostname)}/password-reset?token=${token}`;
    let sent = true;
    try {
      await this.mail.sendToQueue({ to: target.email, subject: 'Reset your password', template: ForgotPasswordEmail({ username: target.name, resetLink: link }) });
    } catch {
      sent = false;
    }
    this.audit.log({ event: AuditEvent.USER_PASSWORD_RESET_REQUESTED, resourceType: AuditResource.USER, resourceId: target.id, metadata: { source: 'admin' } } as any);
    return { sent, link: auth.role === UserRole.OWNER ? link : null };
  }

  // Owners only: a temporary password, every session signed out.
  async setPassword(auth: User, workspace: Workspace, userId: string, password: string) {
    if (auth.role !== UserRole.OWNER) throw new ForbiddenException('Only owners set passwords');
    const target = await this.target(auth, workspace, userId);
    if (password.length < 8) throw new BadRequestException('Passwords need at least 8 characters');
    const hashed = await hashPassword(password);
    await this.userRepo.updateUser({ password: hashed, hasGeneratedPassword: true } as any, target.id, workspace.id);
    await this.sessions.revokeByUserId(target.id, workspace.id);
    this.ws.disconnectUser(target.id);
    this.audit.log({ event: AuditEvent.USER_PASSWORD_CHANGED, resourceType: AuditResource.USER, resourceId: target.id, metadata: { byAdmin: true } } as any);
    return { ok: true };
  }

  async setPasswordLogin(auth: User, workspace: Workspace, userId: string, locked: boolean) {
    const target = await this.target(auth, workspace, userId);
    if (target.id === auth.id && locked) throw new BadRequestException('You cannot lock yourself out');
    await this.userRepo.updateUser({ passwordLoginLocked: locked } as any, target.id, workspace.id);
    this.audit.log({ event: locked ? AuditEvent.USER_PASSWORD_LOGIN_LOCKED : AuditEvent.USER_PASSWORD_LOGIN_UNLOCKED, resourceType: AuditResource.USER, resourceId: target.id } as any);
    return this.userRepo.findById(target.id, workspace.id);
  }

  private async target(auth: User, workspace: Workspace, userId: string): Promise<User> {
    const ability = this.workspaceAbility.createForUser(auth, workspace);
    if (ability.cannot(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Member)) throw new ForbiddenException();
    const target = await this.userRepo.findById(userId, workspace.id);
    if (!target || target.deletedAt) throw new NotFoundException('Member not found');
    if (target.role === UserRole.OWNER && auth.role !== UserRole.OWNER) throw new ForbiddenException('Only owners manage owners');
    return target;
  }
}
