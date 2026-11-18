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

// Built-in AI: provider credentials, model discovery, Ask AI in the editor,
// page embeddings with AI Answers in search, and the chat with tools over
// the workspace's pages.
@Module({
  imports: [PageModule, PageAccessModule, SearchModule, AttachmentModule, StorageModule, BaseModule],
  controllers: [AiController, AiChatController],
  providers: [
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
  ],
  exports: [AiSettingsService, AiProviderService, AiGenerateService, AiEmbeddingService, AiAnswersService, AiChatToolsService],
})
export class AiModule {}
