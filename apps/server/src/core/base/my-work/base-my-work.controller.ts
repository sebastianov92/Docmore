import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { AuthUser } from '../../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../../common/decorators/auth-workspace.decorator';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { BaseMyWorkService } from './base-my-work.service';

class MyWorkDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(60)
  days?: number;
}

@UseGuards(JwtAuthGuard)
@Controller('bases')
export class BaseMyWorkController {
  constructor(private readonly service: BaseMyWorkService) {}

  @HttpCode(HttpStatus.OK)
  @Post('my-work')
  async myWork(@Body() dto: MyWorkDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return this.service.forUser(user.id, workspace.id, dto.days ?? 7);
  }
}
