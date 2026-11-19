import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { promises as dns } from 'node:dns';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { Workspace } from '@docmost/db/types/entity.types';
import { nanoIdGen } from '../../../common/helpers';
import { AUDIT_SERVICE, IAuditService } from '../../../integrations/audit/audit.service';
import { AuditEvent, AuditResource } from '../../../common/events/audit-events';

export interface VerifiedDomain {
  domain: string;
  token: string;
  createdAt: string;
  verifiedAt: string | null;
}

export interface DomainSettings {
  verified: VerifiedDomain[];
  autoJoin: boolean;
}

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export const DOMAIN_TXT_PREFIX = 'docmore-verify=';

// A domain proves ownership with a DNS TXT record; once verified and
// auto-join is on, anyone with an email on it can sign up alone.
@Injectable()
export class WorkspaceDomainService {
  constructor(
    private readonly workspaceRepo: WorkspaceRepo,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
  ) {}

  read(workspace: Pick<Workspace, 'settings'>): DomainSettings {
    const raw = ((workspace?.settings as any)?.domains ?? {}) as Partial<DomainSettings>;
    return {
      verified: Array.isArray(raw.verified) ? raw.verified : [],
      autoJoin: raw.autoJoin === true,
    };
  }

  // Domains open for self sign-up: verified, with auto-join on.
  signupDomains(workspace: Pick<Workspace, 'settings'>): string[] {
    const settings = this.read(workspace);
    if (!settings.autoJoin) return [];
    return settings.verified.filter((d) => d.verifiedAt).map((d) => d.domain);
  }

  canAutoJoin(workspace: Pick<Workspace, 'settings'>, email: string): boolean {
    const domain = (email.split('@')[1] ?? '').toLowerCase();
    return this.signupDomains(workspace).includes(domain);
  }

  async list(workspaceId: string) {
    const workspace = await this.workspaceRepo.findById(workspaceId);
    return { ...this.read(workspace), txtPrefix: DOMAIN_TXT_PREFIX };
  }

  private async write(workspaceId: string, next: DomainSettings) {
    const workspace = await this.workspaceRepo.findById(workspaceId);
    if (!workspace) throw new NotFoundException('Workspace not found');
    const settings = { ...((workspace.settings as any) ?? {}), domains: next };
    await this.workspaceRepo.updateWorkspace({ settings: settings as any }, workspaceId);
    return { ...next, txtPrefix: DOMAIN_TXT_PREFIX };
  }

  async add(workspaceId: string, rawDomain: string) {
    const domain = rawDomain.trim().toLowerCase().replace(/^@/, '');
    if (!DOMAIN_RE.test(domain)) throw new BadRequestException('Enter a valid domain name');
    const workspace = await this.workspaceRepo.findById(workspaceId);
    const current = this.read(workspace);
    if (current.verified.some((d) => d.domain === domain)) {
      throw new BadRequestException('Domain already added');
    }
    if (current.verified.length >= 20) throw new BadRequestException('Too many domains');
    const entry: VerifiedDomain = {
      domain,
      token: nanoIdGen(24),
      createdAt: new Date().toISOString(),
      verifiedAt: null,
    };
    const result = await this.write(workspaceId, {
      ...current,
      verified: [...current.verified, entry],
    });
    this.auditService.log({
      event: AuditEvent.WORKSPACE_DOMAIN_ADDED,
      resourceType: AuditResource.WORKSPACE,
      resourceId: workspaceId,
      metadata: { domain },
    });
    return result;
  }

  async verify(workspaceId: string, rawDomain: string) {
    const domain = rawDomain.trim().toLowerCase();
    const workspace = await this.workspaceRepo.findById(workspaceId);
    const current = this.read(workspace);
    const entry = current.verified.find((d) => d.domain === domain);
    if (!entry) throw new NotFoundException('Domain not found');
    const expected = `${DOMAIN_TXT_PREFIX}${entry.token}`;
    let records: string[] = [];
    try {
      const raw = await dns.resolveTxt(domain);
      records = raw.map((chunks) => chunks.join(''));
    } catch (err: any) {
      throw new BadRequestException(
        `No TXT record found for ${domain} yet (${err?.code ?? 'lookup failed'})`,
      );
    }
    if (!records.some((r) => r.trim() === expected)) {
      throw new BadRequestException(
        `The TXT record "${expected}" is not published on ${domain} yet`,
      );
    }
    entry.verifiedAt = new Date().toISOString();
    const result = await this.write(workspaceId, current);
    this.auditService.log({
      event: AuditEvent.WORKSPACE_DOMAIN_VERIFIED,
      resourceType: AuditResource.WORKSPACE,
      resourceId: workspaceId,
      metadata: { domain },
    });
    return result;
  }

  async remove(workspaceId: string, rawDomain: string) {
    const domain = rawDomain.trim().toLowerCase();
    const workspace = await this.workspaceRepo.findById(workspaceId);
    const current = this.read(workspace);
    const result = await this.write(workspaceId, {
      ...current,
      verified: current.verified.filter((d) => d.domain !== domain),
    });
    this.auditService.log({
      event: AuditEvent.WORKSPACE_DOMAIN_REMOVED,
      resourceType: AuditResource.WORKSPACE,
      resourceId: workspaceId,
      metadata: { domain },
    });
    return result;
  }

  async setAutoJoin(workspaceId: string, autoJoin: boolean) {
    const workspace = await this.workspaceRepo.findById(workspaceId);
    const current = this.read(workspace);
    return this.write(workspaceId, { ...current, autoJoin });
  }
}
