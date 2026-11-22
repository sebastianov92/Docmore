import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { IsUUID } from 'class-validator';
import { FastifyReply, FastifyRequest } from 'fastify';
import { Public } from '../../../common/decorators/public.decorator';
import { AuthUser } from '../../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../../common/decorators/auth-workspace.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { BaseCalendarFeedService } from './base-calendar-feed.service';

class CalendarFeedDto {
  @IsUUID()
  pageId: string;

  @IsUUID()
  viewId: string;
}

// The private .ics link of a view: looked at, made (or made anew) and
// turned off by the person it belongs to.
@UseGuards(JwtAuthGuard)
@Controller('bases/calendar-feed')
export class BaseCalendarFeedController {
  constructor(private readonly feeds: BaseCalendarFeedService) {}

  @HttpCode(HttpStatus.OK)
  @Post('info')
  info(@Body() dto: CalendarFeedDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return this.feeds.info(user, workspace.id, dto.pageId, dto.viewId);
  }

  @HttpCode(HttpStatus.OK)
  @Post('create')
  create(@Body() dto: CalendarFeedDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return this.feeds.create(user, workspace.id, dto.pageId, dto.viewId);
  }

  @HttpCode(HttpStatus.OK)
  @Post('remove')
  remove(@Body() dto: CalendarFeedDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return this.feeds.remove(user, workspace.id, dto.pageId, dto.viewId);
  }
}

// What a calendar app asks for: no session, the secret in the address.
@Controller('bases/calendar-feed')
export class BaseCalendarFeedPublicController {
  constructor(private readonly feeds: BaseCalendarFeedService) {}

  @Public()
  @Get(':file')
  async read(
    @Param('file') file: string,
    @AuthWorkspace() workspace: Workspace,
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
  ) {
    const token = String(file ?? '').replace(/\.ics$/i, '');
    const forwarded = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim();
    const origin = `${forwarded || req.protocol}://${req.headers.host}`;
    const ics = workspace ? await this.feeds.render(token, workspace.id, origin) : null;
    if (ics === null) {
      // one answer for every reason, so an address tells nothing
      return res.status(404).header('content-type', 'text/plain; charset=utf-8').send('Calendar not found');
    }
    return res
      .status(200)
      .header('content-type', 'text/calendar; charset=utf-8')
      .header('content-disposition', 'inline; filename="calendar.ics"')
      .header('cache-control', 'private, max-age=300')
      .send(ics);
  }
}
