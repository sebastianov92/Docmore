import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TokenModule } from '../auth/token.module';
import { WorkspaceModule } from '../workspace/workspace.module';
import { SsoController } from './sso.controller';
import { SsoOidcController } from './sso-oidc.controller';
import { SsoService } from './sso.service';
import { OidcService } from './oidc.service';

// Docmore's own single sign-on (OpenID Connect), AGPL, outside ee/.
@Module({
  imports: [AuthModule, TokenModule, WorkspaceModule],
  controllers: [SsoController, SsoOidcController],
  providers: [SsoService, OidcService],
  exports: [SsoService],
})
export class SsoModule {}
