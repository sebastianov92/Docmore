import { Module } from '@nestjs/common';
import { TokenModule } from '../auth/token.module';
import { OAuthService } from './oauth.service';
import { OAuthController, OAuthMetadataController } from './oauth.controller';

// OAuth 2.1 authorization server used by MCP clients.
@Module({
  imports: [TokenModule],
  controllers: [OAuthController, OAuthMetadataController],
  providers: [OAuthService],
  exports: [OAuthService],
})
export class OAuthModule {}
