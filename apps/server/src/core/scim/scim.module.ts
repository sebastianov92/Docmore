import { Module } from '@nestjs/common';
import { ScimService } from './scim.service';
import { ScimTokenService } from './scim-token.service';
import { ScimGuard } from './scim.guard';
import { ScimController } from './scim.controller';
import { ScimTokenController } from './scim-token.controller';

@Module({
  controllers: [ScimController, ScimTokenController],
  providers: [ScimService, ScimTokenService, ScimGuard],
})
export class ScimModule {}
