import { BadRequestException, Body, Controller, HttpCode, HttpStatus, PayloadTooLargeException, Post, Req, UseGuards } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Matches, MaxLength, Min, ValidateIf, ValidateNested } from 'class-validator';
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

const SPEAKER_ID = /^[a-z0-9_-]{1,40}$/;
const MODES = ['in_person', 'virtual'];
const SIDES = ['room', 'remote'];

class TranscriptSegmentDto {
  @IsNumber()
  start: number;

  @IsNumber()
  end: number;

  @IsString()
  @MaxLength(4000)
  text: string;

  // which voice said it, when voices were told apart
  @IsOptional()
  @Matches(SPEAKER_ID)
  speaker?: string;

  // virtual meetings: this side of the call or the other
  @IsOptional()
  @IsIn(SIDES)
  side?: string;
}

class SpeakerDto {
  @Matches(SPEAKER_ID)
  id: string;

  @IsInt()
  @Min(1)
  number: number;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsIn(SIDES)
  side?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(80)
  name?: string | null;
}

class LiveStartDto {
  @IsOptional()
  @IsUUID()
  pageId?: string;

  @IsOptional()
  @IsUUID()
  spaceId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsIn(MODES)
  mode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  language?: string;
}

class LiveUpdateDto {
  @IsUUID()
  meetingId: string;

  @IsInt()
  @Min(0)
  fromIndex: number;

  @IsArray()
  @ArrayMaxSize(2_000)
  @ValidateNested({ each: true })
  @Type(() => TranscriptSegmentDto)
  segments: TranscriptSegmentDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => SpeakerDto)
  speakers?: SpeakerDto[];

  @IsOptional()
  @IsNumber()
  durationSeconds?: number;
}

class ItemOpDto {
  @IsUUID()
  meetingId: string;

  @IsIn(['add', 'update', 'cancel', 'restore', 'remove'])
  op: 'add' | 'update' | 'cancel' | 'restore' | 'remove';

  @IsOptional()
  @IsString()
  @MaxLength(40)
  id?: string;

  @IsOptional()
  @IsIn(['agreement', 'task'])
  kind?: 'agreement' | 'task';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  text?: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(120)
  owner?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(120)
  due?: string | null;
}

class PageIdDto {
  @IsUUID()
  pageId: string;
}

class RenameSpeakerDto {
  @IsUUID()
  meetingId: string;

  @Matches(SPEAKER_ID)
  speakerId: string;

  // empty: back to the default label
  @IsString()
  @MaxLength(80)
  name: string;
}

class MergeSpeakersDto {
  @IsUUID()
  meetingId: string;

  @Matches(SPEAKER_ID)
  from: string;

  @Matches(SPEAKER_ID)
  into: string;
}

class FromTranscriptDto {
  @IsOptional()
  @IsUUID()
  pageId?: string;

  @IsOptional()
  @IsUUID()
  spaceId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @IsString()
  @MaxLength(2_000_000)
  transcript: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  language?: string;

  @IsOptional()
  @IsNumber()
  durationSeconds?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20_000)
  @ValidateNested({ each: true })
  @Type(() => TranscriptSegmentDto)
  segments?: TranscriptSegmentDto[];

  // the live meeting this transcript finishes: its list is where the final one starts
  @IsOptional()
  @IsUUID()
  meetingId?: string;

  @IsOptional()
  @IsIn(MODES)
  mode?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => SpeakerDto)
  speakers?: SpeakerDto[];
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
      file = await req.file({ limits: { fileSize: MAX_MEETING_FILE_BYTES, fields: 6, files: 1 } });
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
    return this.meetings.start(user, workspace, Promise.resolve(file), {
      pageId: field('pageId'),
      spaceId: field('spaceId'),
      meetingId: field('meetingId'),
      mode: field('mode'),
    });
  }

  // A transcript made on the device (the desktop app): only the notes are
  // written here. Works without a transcription model.
  @HttpCode(HttpStatus.OK)
  @Post('from-transcript')
  async fromTranscript(@Body() dto: FromTranscriptDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    await this.usage.assertAllowed(workspace, user);
    return this.meetings.startFromTranscript(user, workspace, dto);
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

  // A meeting starts: its transcript arrives in pieces and the list of
  // agreements and tasks is kept as it goes.
  @HttpCode(HttpStatus.OK)
  @Post('live/start')
  async liveStart(@Body() dto: LiveStartDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    await this.usage.assertAllowed(workspace, user);
    return this.meetings.liveStart(user, workspace, dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post('live/update')
  async liveUpdate(@Body() dto: LiveUpdateDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return this.meetings.liveUpdate(user, workspace, dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post('live/discard')
  async liveDiscard(@Body() dto: MeetingIdDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return this.meetings.liveDiscard(user, workspace, dto.meetingId);
  }

  // The person edits the list by hand.
  @HttpCode(HttpStatus.OK)
  @Post('items')
  async items(@Body() dto: ItemOpDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return this.meetings.userItem(user, workspace, dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post('info')
  async info(@Body() dto: MeetingIdDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return this.meetings.info(user, workspace, dto.meetingId);
  }

  @HttpCode(HttpStatus.OK)
  @Post('by-page')
  async byPage(@Body() dto: PageIdDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return { items: await this.meetings.byPage(user, workspace, dto.pageId) };
  }

  @HttpCode(HttpStatus.OK)
  @Post('speakers/rename')
  async renameSpeaker(@Body() dto: RenameSpeakerDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return this.meetings.renameSpeaker(user, workspace, dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post('speakers/merge')
  async mergeSpeakers(@Body() dto: MergeSpeakersDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return this.meetings.mergeSpeakers(user, workspace, dto);
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
