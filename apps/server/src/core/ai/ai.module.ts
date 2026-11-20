import { Module } from '@nestjs/common';
import { AiController } from './ai.controller';
import { AiSettingsService } from './ai-settings.service';
import { AiProviderService } from './ai-provider.service';
import { AiGenerateService } from './ai-generate.service';
import { AiEmbeddingService } from './embeddings/ai-embedding.service';
import { AiAnswersService } from './embeddings/ai-answers.service';
import { AiProcessor } from './ai.processor';
import { AiChatController } from './chat/ai-chat.controller';
import { AiChatService } from './chat/ai-chat.service';
import { AiChatRepo } from './chat/ai-chat.repo';
import { AiChatToolsService } from './chat/ai-chat-tools.service';
import { PageModule } from '../page/page.module';
import { PageAccessModule } from '../page/page-access/page-access.module';
import { SearchModule } from '../search/search.module';
import { AttachmentModule } from '../attachment/attachment.module';
import { StorageModule } from '../../integrations/storage/storage.module';
import { BaseModule } from '../base/base.module';
import { AiBaseToolsService } from './chat/ai-base-tools.service';
import { AiUsageService } from './ai-usage.service';
import { AiBaseFillService } from './base-fill/ai-base-fill.service';
import { AiBaseFillListener } from './base-fill/ai-base-fill.listener';
import { AiBaseFillController } from './base-fill/ai-base-fill.controller';
import { AiMcpServerService } from './mcp-client/ai-mcp-server.service';
import { AiMcpToolsService } from './mcp-client/ai-mcp-tools.service';
import { AiMcpController } from './mcp-client/ai-mcp.controller';
import { AiSkillService } from './skills/ai-skill.service';
import { AiSkillController } from './skills/ai-skill.controller';
import { AiResearchService } from './research/ai-research.service';
import { AiResearchController } from './research/ai-research.controller';
import { AiTranscriptionService } from './meetings/ai-transcription.service';
import { AiMeetingService } from './meetings/ai-meeting.service';
import { AiMeetingController } from './meetings/ai-meeting.controller';
import { NotificationModule } from '../notification/notification.module';

// Built-in AI: provider credentials, model discovery, Ask AI in the editor,
// page embeddings with AI Answers in search, and the chat with tools over
// the workspace's pages.
@Module({
  imports: [PageModule, PageAccessModule, SearchModule, AttachmentModule, StorageModule, BaseModule, NotificationModule],
  controllers: [AiController, AiChatController, AiBaseFillController, AiMcpController, AiSkillController, AiResearchController, AiMeetingController],
  providers: [
    AiBaseFillService,
    AiBaseFillListener,
    AiUsageService,
    AiSettingsService,
    AiProviderService,
    AiGenerateService,
    AiEmbeddingService,
    AiAnswersService,
    AiProcessor,
    AiChatRepo,
    AiChatToolsService,
    AiBaseToolsService,
    AiChatService,
    AiMcpServerService,
    AiMcpToolsService,
    AiSkillService,
    AiResearchService,
    AiTranscriptionService,
    AiMeetingService,
  ],
  exports: [AiSettingsService, AiProviderService, AiGenerateService, AiEmbeddingService, AiAnswersService, AiChatToolsService, AiSkillService],
})
export class AiModule {}
