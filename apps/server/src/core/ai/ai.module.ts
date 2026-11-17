import { Module } from '@nestjs/common';
import { AiController } from './ai.controller';
import { AiSettingsService } from './ai-settings.service';
import { AiProviderService } from './ai-provider.service';
import { AiGenerateService } from './ai-generate.service';
import { AiEmbeddingService } from './embeddings/ai-embedding.service';
import { AiAnswersService } from './embeddings/ai-answers.service';
import { AiProcessor } from './ai.processor';

// Built-in AI: provider credentials, model discovery, Ask AI in the editor,
// page embeddings and AI Answers in search. Chat builds on the same pieces.
@Module({
  controllers: [AiController],
  providers: [
    AiSettingsService,
    AiProviderService,
    AiGenerateService,
    AiEmbeddingService,
    AiAnswersService,
    AiProcessor,
  ],
  exports: [AiSettingsService, AiProviderService, AiGenerateService, AiEmbeddingService, AiAnswersService],
})
export class AiModule {}
