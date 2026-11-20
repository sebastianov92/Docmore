import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TokenModule } from '../auth/token.module';
import { WorkspaceModule } from '../workspace/workspace.module';
import { SsoController } from './sso.controller';
import { SsoOidcController } from './sso-oidc.controller';
import { SsoService } from './sso.service';
import { OidcService } from './oidc.service';
import { SsoSamlController } from './sso-saml.controller';
import { SamlService } from './saml.service';

// Docmore's own single sign-on (OpenID Connect), AGPL, outside ee/.
@Module({
  imports: [AuthModule, TokenModule, WorkspaceModule],
  controllers: [SsoController, SsoOidcController, SsoSamlController],
  providers: [SsoService, OidcService, SamlService],
  exports: [SsoService],
})
export class SsoModule {}
