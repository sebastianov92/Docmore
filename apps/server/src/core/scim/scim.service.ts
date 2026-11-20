import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { randomBytes } from 'crypto';
import { sql } from 'kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { GroupRepo } from '@docmost/db/repos/group/group.repo';
import { GroupUserRepo } from '@docmost/db/repos/group/group-user.repo';
import { UserRole } from '../../common/helpers/types/permission';

export const SCIM_USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
export const SCIM_GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';
export const SCIM_LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
export const SCIM_PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';

type ScimFilter = { attribute: string; value: string } | null;

// SCIM 2.0 over Docmore users and groups: provisioning, deprovisioning
// (deactivate) and group membership from an identity provider.
@Injectable()
export class ScimService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly userRepo: UserRepo,
    private readonly groupRepo: GroupRepo,
    private readonly groupUserRepo: GroupUserRepo,
  ) {}

  // ---------- users
  async listUsers(workspaceId: string, filter: string | undefined, startIndex = 1, count = 100, baseUrl: string) {
    const f = parseFilter(filter);
    let q = this.db.selectFrom('users').selectAll().where('workspaceId', '=', workspaceId).where('deletedAt', 'is', null);
    if (f) {
      if (f.attribute === 'username' || f.attribute === 'emails.value' || f.attribute === 'emails') q = q.where(sql`lower(email)`, '=', f.value.toLowerCase());
      else if (f.attribute === 'externalid') q = q.where('scimExternalId', '=', f.value);
      else if (f.attribute === 'id') q = q.where('id', '=', f.value);
      else throw new BadRequestException(`Unsupported filter attribute: ${f.attribute}`);
    }
    const total = await q.clearSelect().select(sql<number>`count(*)::int`.as('n')).executeTakeFirst();
    const rows = await q.orderBy('createdAt', 'asc').offset(Math.max(startIndex - 1, 0)).limit(Math.min(Math.max(count, 1), 200)).execute();
    return this.list(rows.map((u) => this.userResource(u, baseUrl)), (total as any)?.n ?? rows.length, startIndex);
  }

  async getUser(workspaceId: string, id: string, baseUrl: string) {
    const user = await this.findUser(workspaceId, id);
    return this.userResource(user, baseUrl);
  }

  async createUser(workspaceId: string, body: any, baseUrl: string) {
    const email = String(body?.userName ?? body?.emails?.find?.((e: any) => e.primary)?.value ?? body?.emails?.[0]?.value ?? '').trim().toLowerCase();
    if (!email || !email.includes('@')) throw new BadRequestException('userName must be an email address');
    const existing = await this.userRepo.findByEmail(email, workspaceId);
    if (existing) {
      if (existing.deletedAt) throw new ConflictException('A deleted user with this email exists');
      throw new ConflictException('User already exists');
    }
    const name = displayName(body) ?? email.split('@')[0];
    const user = await this.userRepo.insertUser({
      email,
      name,
      password: randomBytes(16).toString('hex'),
      role: UserRole.MEMBER,
      workspaceId,
      scimExternalId: body?.externalId ? String(body.externalId) : null,
      emailVerifiedAt: new Date(),
      ...(body?.active === false ? { deactivatedAt: new Date() } : {}),
    } as any);
    await this.groupUserRepo.addUserToDefaultGroup(user.id, workspaceId);
    return this.userResource(await this.findUser(workspaceId, user.id), baseUrl);
  }

  async replaceUser(workspaceId: string, id: string, body: any, baseUrl: string) {
    const user = await this.findUser(workspaceId, id);
    const patch: Record<string, unknown> = {};
    const name = displayName(body);
    if (name) patch.name = name;
    if (body?.userName && String(body.userName).toLowerCase() !== user.email.toLowerCase()) patch.email = String(body.userName).toLowerCase();
    if (body?.externalId !== undefined) patch.scimExternalId = body.externalId ? String(body.externalId) : null;
    if (body?.active !== undefined) patch.deactivatedAt = body.active ? null : (user as any).deactivatedAt ?? new Date();
    if (Object.keys(patch).length) await this.userRepo.updateUser(patch as any, user.id, workspaceId);
    return this.userResource(await this.findUser(workspaceId, id), baseUrl);
  }

  async patchUser(workspaceId: string, id: string, body: any, baseUrl: string) {
    const user = await this.findUser(workspaceId, id);
    const patch: Record<string, unknown> = {};
    for (const op of body?.Operations ?? []) {
      const operation = String(op.op ?? '').toLowerCase();
      const path = String(op.path ?? '').toLowerCase();
      const value = op.value;
      const apply = (attr: string, v: unknown) => {
        if (attr === 'active') patch.deactivatedAt = v === true || v === 'true' || v === 'True' ? null : new Date();
        else if (attr === 'username') patch.email = String(v).toLowerCase();
        else if (attr === 'externalid') patch.scimExternalId = v ? String(v) : null;
        else if (attr === 'displayname' || attr === 'name.formatted') patch.name = String(v);
        else if (attr === 'name' && v && typeof v === 'object') {
          const n = displayName({ name: v });
          if (n) patch.name = n;
        }
      };
      if (operation === 'replace' || operation === 'add') {
        if (path) apply(path.replace(/^urn:.*:user:/, ''), value);
        else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) apply(k.toLowerCase(), v);
      } else if (operation === 'remove' && path === 'active') {
        patch.deactivatedAt = new Date();
      }
    }
    if (Object.keys(patch).length) await this.userRepo.updateUser(patch as any, user.id, workspaceId);
    return this.userResource(await this.findUser(workspaceId, id), baseUrl);
  }

  // Deprovision: the account is deactivated and marked deleted, never purged.
  async deleteUser(workspaceId: string, id: string) {
    const user = await this.findUser(workspaceId, id);
    await this.userRepo.updateUser({ deactivatedAt: new Date() } as any, user.id, workspaceId);
  }

  // ---------- groups
  async listGroups(workspaceId: string, filter: string | undefined, startIndex = 1, count = 100, baseUrl: string) {
    const f = parseFilter(filter);
    let q = this.db.selectFrom('groups').selectAll().where('workspaceId', '=', workspaceId);
    if (f) {
      if (f.attribute === 'displayname') q = q.where(sql`lower(name)`, '=', f.value.toLowerCase());
      else if (f.attribute === 'externalid') q = q.where('scimExternalId', '=', f.value);
      else if (f.attribute === 'id') q = q.where('id', '=', f.value);
      else throw new BadRequestException(`Unsupported filter attribute: ${f.attribute}`);
    }
    const total = await q.clearSelect().select(sql<number>`count(*)::int`.as('n')).executeTakeFirst();
    const rows = await q.orderBy('createdAt', 'asc').offset(Math.max(startIndex - 1, 0)).limit(Math.min(Math.max(count, 1), 200)).execute();
    const resources = [];
    for (const g of rows) resources.push(await this.groupResource(g, baseUrl));
    return this.list(resources, (total as any)?.n ?? rows.length, startIndex);
  }

  async getGroup(workspaceId: string, id: string, baseUrl: string) {
    return this.groupResource(await this.findGroup(workspaceId, id), baseUrl);
  }

  async createGroup(workspaceId: string, body: any, baseUrl: string) {
    const name = String(body?.displayName ?? '').trim();
    if (!name) throw new BadRequestException('displayName is required');
    if (await this.groupRepo.findByName(name, workspaceId)) throw new ConflictException('Group already exists');
    const group = await this.groupRepo.insertGroup({ name, description: null, workspaceId, isDefault: false, creatorId: null, scimExternalId: body?.externalId ? String(body.externalId) : null } as any);
    await this.setMembers(workspaceId, group.id, memberIds(body?.members), 'replace');
    return this.groupResource(await this.findGroup(workspaceId, group.id), baseUrl);
  }

  async replaceGroup(workspaceId: string, id: string, body: any, baseUrl: string) {
    const group = await this.findGroup(workspaceId, id);
    const patch: Record<string, unknown> = {};
    if (body?.displayName && body.displayName !== group.name) patch.name = String(body.displayName).trim();
    if (body?.externalId !== undefined) patch.scimExternalId = body.externalId ? String(body.externalId) : null;
    if (Object.keys(patch).length) await this.db.updateTable('groups').set({ ...(patch as any), updatedAt: new Date() }).where('id', '=', group.id).execute();
    if (Array.isArray(body?.members)) await this.setMembers(workspaceId, group.id, memberIds(body.members), 'replace');
    return this.groupResource(await this.findGroup(workspaceId, id), baseUrl);
  }

  async patchGroup(workspaceId: string, id: string, body: any, baseUrl: string) {
    const group = await this.findGroup(workspaceId, id);
    for (const op of body?.Operations ?? []) {
      const operation = String(op.op ?? '').toLowerCase();
      const path = String(op.path ?? '');
      if (/^members/i.test(path) || (!path && op.value?.members)) {
        const ids = memberIds(path ? op.value : op.value.members);
        // members[value eq "id"] in the path names one member
        const fromPath = /members\[value eq "([^"]+)"\]/i.exec(path)?.[1];
        if (operation === 'remove') await this.setMembers(workspaceId, group.id, fromPath ? [fromPath] : ids, 'remove');
        else if (operation === 'add') await this.setMembers(workspaceId, group.id, ids, 'add');
        else await this.setMembers(workspaceId, group.id, ids, 'replace');
      } else if ((operation === 'replace' || operation === 'add') && (/^displayname$/i.test(path) || (!path && op.value?.displayName))) {
        const name = String(path ? op.value : op.value.displayName).trim();
        if (name) await this.db.updateTable('groups').set({ name, updatedAt: new Date() }).where('id', '=', group.id).execute();
      } else if ((operation === 'replace' || operation === 'add') && /^externalid$/i.test(path)) {
        await this.db.updateTable('groups').set({ scimExternalId: op.value ? String(op.value) : null } as any).where('id', '=', group.id).execute();
      }
    }
    return this.groupResource(await this.findGroup(workspaceId, id), baseUrl);
  }

  async deleteGroup(workspaceId: string, id: string) {
    const group = await this.findGroup(workspaceId, id);
    if (group.isDefault) throw new BadRequestException('The default group cannot be deleted');
    await this.groupRepo.delete(group.id, workspaceId, {});
  }

  // ---------- shapes
  private userResource(u: any, baseUrl: string) {
    const [given, ...rest] = String(u.name ?? '').split(' ');
    return {
      schemas: [SCIM_USER_SCHEMA],
      id: u.id,
      externalId: u.scimExternalId ?? undefined,
      userName: u.email,
      name: { formatted: u.name ?? '', givenName: given ?? '', familyName: rest.join(' ') },
      displayName: u.name ?? '',
      emails: [{ value: u.email, type: 'work', primary: true }],
      active: !u.deactivatedAt && !u.deletedAt,
      meta: { resourceType: 'User', created: u.createdAt, lastModified: u.updatedAt, location: `${baseUrl}/Users/${u.id}` },
    };
  }

  private async groupResource(g: any, baseUrl: string) {
    const members = await this.db
      .selectFrom('groupUsers')
      .innerJoin('users', 'users.id', 'groupUsers.userId')
      .select(['users.id', 'users.name', 'users.email'])
      .where('groupUsers.groupId', '=', g.id)
      .execute();
    return {
      schemas: [SCIM_GROUP_SCHEMA],
      id: g.id,
      externalId: g.scimExternalId ?? undefined,
      displayName: g.name,
      members: members.map((m) => ({ value: m.id, display: m.name ?? m.email, $ref: `${baseUrl}/Users/${m.id}` })),
      meta: { resourceType: 'Group', created: g.createdAt, lastModified: g.updatedAt, location: `${baseUrl}/Groups/${g.id}` },
    };
  }

  private list(resources: unknown[], total: number, startIndex: number) {
    return { schemas: [SCIM_LIST_SCHEMA], totalResults: total, startIndex, itemsPerPage: resources.length, Resources: resources };
  }

  private async findUser(workspaceId: string, id: string) {
    const user = await this.db.selectFrom('users').selectAll().where('id', '=', id).where('workspaceId', '=', workspaceId).where('deletedAt', 'is', null).executeTakeFirst();
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  private async findGroup(workspaceId: string, id: string) {
    const group = await this.db.selectFrom('groups').selectAll().where('id', '=', id).where('workspaceId', '=', workspaceId).executeTakeFirst();
    if (!group) throw new NotFoundException('Group not found');
    return group;
  }

  private async setMembers(workspaceId: string, groupId: string, ids: string[], mode: 'replace' | 'add' | 'remove') {
    const current = new Set(await this.groupUserRepo.getUserIdsByGroupId(groupId));
    const wanted = new Set(ids);
    if (mode === 'remove') {
      for (const id of wanted) if (current.has(id)) await this.groupUserRepo.delete(id, groupId, {});
      return;
    }
    for (const id of wanted) {
      if (current.has(id)) continue;
      const user = await this.db.selectFrom('users').select(['id']).where('id', '=', id).where('workspaceId', '=', workspaceId).where('deletedAt', 'is', null).executeTakeFirst();
      if (!user) continue;
      await this.groupUserRepo.addUserToGroup(id, groupId, workspaceId);
    }
    if (mode === 'replace') for (const id of current) if (!wanted.has(id)) await this.groupUserRepo.delete(id, groupId, {});
  }
}

// `userName eq "x"`: the one filter shape identity providers send.
function parseFilter(filter: string | undefined): ScimFilter {
  if (!filter) return null;
  const m = /^\s*([\w.$:]+)\s+eq\s+"([^"]*)"\s*$/i.exec(filter);
  if (!m) throw new BadRequestException('Unsupported filter');
  return { attribute: m[1].toLowerCase(), value: m[2] };
}

function displayName(body: any): string | null {
  const formatted = body?.name?.formatted ?? body?.displayName;
  if (typeof formatted === 'string' && formatted.trim()) return formatted.trim();
  const parts = [body?.name?.givenName, body?.name?.familyName].filter((p) => typeof p === 'string' && p.trim());
  return parts.length ? parts.join(' ') : null;
}

function memberIds(members: unknown): string[] {
  if (!Array.isArray(members)) return [];
  return members.map((m: any) => (typeof m === 'string' ? m : m?.value)).filter((v): v is string => typeof v === 'string' && v.length > 0);
}
