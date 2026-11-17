import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { Transform, TransformFnParams } from 'class-transformer';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { RequireSessionAuth } from '../../common/decorators/require-session-auth.decorator';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { PersonalSpaceService } from './services/personal-space.service';

export class CreatePersonalSpaceDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  @Transform(({ value }: TransformFnParams) =>
    typeof value === 'string' ? value.trim() : value,
  )
  name?: string;
}

@UseGuards(JwtAuthGuard)
@RequireSessionAuth()
@Controller('personal-space')
export class PersonalSpaceController {
  constructor(private readonly personalSpaceService: PersonalSpaceService) {}

  // The caller's own personal space, or null when they have none yet.
  @HttpCode(HttpStatus.OK)
  @Post('info')
  async info(@AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    const space = await this.personalSpaceService.find(user, workspace.id);
    return { space };
  }

  @HttpCode(HttpStatus.OK)
  @Post('create')
  async create(
    @Body() dto: CreatePersonalSpaceDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.personalSpaceService.create(user, workspace.id, dto.name);
  }
}
