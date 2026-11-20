import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { User, Workspace } from '@docmost/db/types/entity.types';
import WorkspaceAbilityFactory from '../../casl/abilities/workspace-ability.factory';
import { WorkspaceCaslAction, WorkspaceCaslSubject } from '../../casl/interfaces/workspace-ability.type';

export interface SkillView {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  instructions: string;
  scope: 'workspace' | 'personal';
  creatorId: string | null;
  enabled: boolean;
  useCount: number;
  createdAt: string;
  updatedAt: string;
}

const MAX_INSTRUCTIONS = 20_000;
const MAX_SKILLS = 200;

// Skills: named instructions the chat (and the editor) can run with one
// pick. Workspace skills are everybody's and admins keep them; personal ones
// belong to who wrote them.
@Injectable()
export class AiSkillService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly workspaceAbility: WorkspaceAbilityFactory,
  ) {}

  async list(user: User, workspace: Workspace, opts: { enabledOnly?: boolean } = {}): Promise<SkillView[]> {
    let q = this.db
      .selectFrom('aiSkills')
      .selectAll()
      .where('workspaceId', '=', workspace.id)
      .where('deletedAt', 'is', null)
      .where((eb) => eb.or([eb('scope', '=', 'workspace'), eb('creatorId', '=', user.id)]));
    if (opts.enabledOnly) q = q.where('enabled', '=', true);
    const rows = await q.orderBy('scope', 'desc').orderBy('name', 'asc').execute();
    return rows.map(view);
  }

  // One skill the user may run, by id or slug.
  async usable(user: User, workspace: Workspace, idOrSlug: string): Promise<SkillView | null> {
    const isId = /^[0-9a-f-]{36}$/i.test(idOrSlug);
    const row = await this.db
      .selectFrom('aiSkills')
      .selectAll()
      .where('workspaceId', '=', workspace.id)
      .where('deletedAt', 'is', null)
      .where('enabled', '=', true)
      .where(isId ? 'id' : 'slug', '=', idOrSlug.toLowerCase())
      .where((eb) => eb.or([eb('scope', '=', 'workspace'), eb('creatorId', '=', user.id)]))
      .executeTakeFirst();
    return row ? view(row) : null;
  }

  async markUsed(skillId: string) {
    await this.db
      .updateTable('aiSkills')
      .set({ useCount: sql`use_count + 1` as any })
      .where('id', '=', skillId)
      .execute();
  }

  async create(
    user: User,
    workspace: Workspace,
    data: { name: string; description?: string; instructions: string; scope: 'workspace' | 'personal' },
  ): Promise<SkillView> {
    if (data.scope === 'workspace') this.assertAdmin(user, workspace);
    const instructions = String(data.instructions ?? '').trim();
    if (!instructions) throw new BadRequestException('Write the instructions');
    if (instructions.length > MAX_INSTRUCTIONS) throw new BadRequestException(`Instructions up to ${MAX_INSTRUCTIONS} characters`);
    const count = await this.db
      .selectFrom('aiSkills')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('workspaceId', '=', workspace.id)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
    if (Number(count?.n ?? 0) >= MAX_SKILLS) throw new BadRequestException(`Up to ${MAX_SKILLS} skills`);
    const slug = await this.uniqueSlug(workspace.id, data.name);
    const row = await this.db
      .insertInto('aiSkills')
      .values({
        workspaceId: workspace.id,
        creatorId: user.id,
        name: data.name.trim().slice(0, 80),
        slug,
        description: data.description?.trim().slice(0, 300) || null,
        instructions,
        scope: data.scope,
        enabled: true,
      } as any)
      .returningAll()
      .executeTakeFirstOrThrow();
    return view(row);
  }

  async update(
    user: User,
    workspace: Workspace,
    data: { skillId: string; name?: string; description?: string | null; instructions?: string; enabled?: boolean; scope?: 'workspace' | 'personal' },
  ): Promise<SkillView> {
    const row = await this.owned(user, workspace, data.skillId);
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (data.name !== undefined) {
      patch.name = data.name.trim().slice(0, 80);
      patch.slug = await this.uniqueSlug(workspace.id, data.name, row.id);
    }
    if (data.description !== undefined) patch.description = data.description?.trim().slice(0, 300) || null;
    if (data.instructions !== undefined) {
      const instructions = data.instructions.trim();
      if (!instructions) throw new BadRequestException('Write the instructions');
      if (instructions.length > MAX_INSTRUCTIONS) throw new BadRequestException(`Instructions up to ${MAX_INSTRUCTIONS} characters`);
      patch.instructions = instructions;
    }
    if (data.enabled !== undefined) patch.enabled = data.enabled;
    if (data.scope !== undefined && data.scope !== row.scope) {
      this.assertAdmin(user, workspace);
      patch.scope = data.scope;
    }
    const updated = await this.db.updateTable('aiSkills').set(patch as any).where('id', '=', row.id).returningAll().executeTakeFirstOrThrow();
    return view(updated);
  }

  async remove(user: User, workspace: Workspace, skillId: string) {
    const row = await this.owned(user, workspace, skillId);
    await this.db.updateTable('aiSkills').set({ deletedAt: new Date() }).where('id', '=', row.id).execute();
  }

  private async owned(user: User, workspace: Workspace, skillId: string) {
    const row = await this.db
      .selectFrom('aiSkills')
      .selectAll()
      .where('id', '=', skillId)
      .where('workspaceId', '=', workspace.id)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('Skill not found');
    if (row.scope === 'workspace') this.assertAdmin(user, workspace);
    else if (row.creatorId !== user.id) throw new ForbiddenException();
    return row;
  }

  private assertAdmin(user: User, workspace: Workspace) {
    const ability = this.workspaceAbility.createForUser(user, workspace);
    if (ability.cannot(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Settings)) {
      throw new ForbiddenException('Only admins manage workspace skills');
    }
  }

  private async uniqueSlug(workspaceId: string, name: string, exceptId?: string): Promise<string> {
    const base =
      name
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'skill';
    for (let i = 0; i < 50; i += 1) {
      const slug = i === 0 ? base : `${base}-${i + 1}`;
      let q = this.db.selectFrom('aiSkills').select('id').where('workspaceId', '=', workspaceId).where('slug', '=', slug).where('deletedAt', 'is', null);
      if (exceptId) q = q.where('id', '!=', exceptId);
      if (!(await q.executeTakeFirst())) return slug;
    }
    throw new BadRequestException('Pick another name');
  }
}

function view(row: any): SkillView {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description ?? null,
    instructions: row.instructions,
    scope: row.scope,
    creatorId: row.creatorId ?? null,
    enabled: Boolean(row.enabled),
    useCount: Number(row.useCount ?? 0),
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}
