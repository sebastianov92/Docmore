import { Module } from '@nestjs/common';
import { AiController } from './ai.controller';
import { AiSettingsService } from './ai-settings.service';
import { AiProviderService } from './ai-provider.service';
import { AiGenerateService } from './ai-generate.service';

// Built-in AI: provider credentials, model discovery and Ask AI in the
// editor. Semantic search and chat build on the same providers.
@Module({
  controllers: [AiController],
  providers: [AiSettingsService, AiProviderService, AiGenerateService],
  exports: [AiSettingsService, AiProviderService, AiGenerateService],
})
export class AiModule {}
