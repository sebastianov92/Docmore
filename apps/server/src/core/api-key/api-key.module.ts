import { Module } from '@nestjs/common';
import { ApiKeyController } from './api-key.controller';
import { ApiKeyService } from './api-key.service';
import { TokenModule } from '../auth/token.module';
import { CaslModule } from '../casl/casl.module';

@Module({
  imports: [TokenModule, CaslModule],
  controllers: [ApiKeyController],
  providers: [ApiKeyService],
  exports: [ApiKeyService],
})
export class ApiKeyModule {}
