import { BadRequestException, Body, Controller, HttpCode, HttpStatus, PayloadTooLargeException, Post, Req, UseGuards } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { IsUUID } from 'class-validator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { AuthUser } from '../../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../../common/decorators/auth-workspace.decorator';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { AiUsageService } from '../ai-usage.service';
import { AiMeetingService, MAX_LIVE_CHUNK_BYTES, MAX_MEETING_FILE_BYTES } from './ai-meeting.service';

class MeetingIdDto {
  @IsUUID()
  meetingId: string;
}

// Meeting notes from a recording: upload, then poll.
@UseGuards(JwtAuthGuard)
@Controller('ai/meetings')
export class AiMeetingController {
  constructor(
    private readonly meetings: AiMeetingService,
    private readonly usage: AiUsageService,
  ) {}

  // multipart: "file", plus "pageId" or "spaceId".
  @HttpCode(HttpStatus.OK)
  @Post('transcribe')
  async transcribe(@Req() req: FastifyRequest, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    await this.usage.assertAllowed(workspace, user);
    let file: any = null;
    try {
      file = await req.file({ limits: { fileSize: MAX_MEETING_FILE_BYTES, fields: 4, files: 1 } });
    } catch (err: any) {
      if (err?.statusCode === 413) throw new PayloadTooLargeException('Recordings up to 200 MB');
    }
    if (!file) throw new BadRequestException('Failed to upload file');
    // multipart fields that follow the file are not parsed yet, so the query
    // string carries them too
    const query = (req.query ?? {}) as Record<string, string | undefined>;
    const field = (name: string): string | undefined => {
      const f = file.fields?.[name];
      const v = Array.isArray(f) ? f[0]?.value : f?.value;
      if (typeof v === 'string' && v) return v;
      const q = query[name];
      return typeof q === 'string' && q ? q : undefined;
    };
    return this.meetings.start(user, workspace, Promise.resolve(file), { pageId: field('pageId'), spaceId: field('spaceId') });
  }

  // multipart: "file", one piece of a running recording; answers its text.
  @HttpCode(HttpStatus.OK)
  @Post('live')
  async live(@Req() req: FastifyRequest, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    await this.usage.assertAllowed(workspace, user);
    let file: any = null;
    try {
      file = await req.file({ limits: { fileSize: MAX_LIVE_CHUNK_BYTES, fields: 2, files: 1 } });
    } catch (err: any) {
      if (err?.statusCode === 413) throw new PayloadTooLargeException('Chunks up to 25 MB');
    }
    if (!file) throw new BadRequestException('Failed to upload chunk');
    return this.meetings.transcribeChunk(user, workspace, Promise.resolve(file));
  }

  @HttpCode(HttpStatus.OK)
  @Post('status')
  async status(@Body() dto: MeetingIdDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return this.meetings.status(user, workspace, dto.meetingId);
  }

  @HttpCode(HttpStatus.OK)
  @Post()
  async list(@AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return { items: await this.meetings.list(user, workspace) };
  }
}
