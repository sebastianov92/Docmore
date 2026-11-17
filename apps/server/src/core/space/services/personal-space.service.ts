import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { SpaceRepo } from '@docmost/db/repos/space/space.repo';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { Space, User } from '@docmost/db/types/entity.types';
import { SpaceService } from './space.service';
import {
  PERSONAL_SPACE_DEFAULT_NAME,
  personalSpaceSlug,
  slugSuffix,
} from '../personal-space.utils';

// One private space per member, created on demand once an admin allows it
// in Settings > General. Otherwise an ordinary space whose creator is its
// only admin; the spaces table keeps it unique per creator.
@Injectable()
export class PersonalSpaceService {
  constructor(
    private readonly spaceRepo: SpaceRepo,
    private readonly workspaceRepo: WorkspaceRepo,
    private readonly spaceService: SpaceService,
  ) {}

  async find(user: User, workspaceId: string): Promise<Space | null> {
    const space = await this.spaceRepo.findPersonalSpace(user.id, workspaceId);
    return space ?? null;
  }

  async create(
    user: User,
    workspaceId: string,
    name?: string,
  ): Promise<Space> {
    const workspace = await this.workspaceRepo.findById(workspaceId);
    const settings = (workspace?.settings ?? {}) as Record<string, any>;
    if (settings?.spaces?.allowPersonal !== true) {
      throw new ForbiddenException(
        'Personal spaces are turned off in this workspace',
      );
    }

    const existing = await this.spaceRepo.findPersonalSpace(
      user.id,
      workspaceId,
    );
    if (existing) {
      throw new BadRequestException('You already have a personal space');
    }

    const spaceName = name?.trim() || PERSONAL_SPACE_DEFAULT_NAME;
    const slug = await this.freeSlug(personalSpaceSlug(spaceName), workspaceId);

    try {
      return await this.spaceService.createSpace(
        user,
        workspaceId,
        { name: spaceName, slug, description: '' },
        undefined,
        { isPersonal: true },
      );
    } catch (err: any) {
      // Two requests raced past the lookup above; the unique index wins.
      if (err?.code === '23505') {
        throw new BadRequestException('You already have a personal space');
      }
      throw err;
    }
  }

  private async freeSlug(base: string, workspaceId: string): Promise<string> {
    if (!(await this.spaceRepo.slugExists(base, workspaceId))) {
      return base;
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = `${base}-${slugSuffix()}`;
      if (!(await this.spaceRepo.slugExists(candidate, workspaceId))) {
        return candidate;
      }
    }
    return `${base}-${slugSuffix(8)}`;
  }
}
