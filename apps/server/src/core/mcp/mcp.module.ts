import { Module } from '@nestjs/common';
import { TokenModule } from '../auth/token.module';
import { OAuthModule } from '../oauth/oauth.module';
import { AiModule } from '../ai/ai.module';
import { McpController } from './mcp.controller';

// The MCP server for outside assistants, on the chat's tools.
@Module({
  imports: [TokenModule, OAuthModule, AiModule],
  controllers: [McpController],
})
export class McpModule {}
