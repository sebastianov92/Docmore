import { Module } from '@nestjs/common';
import { MfaController } from './mfa.controller';
import { MfaService } from './mfa.service';
import { AuthModule } from '../auth/auth.module';
import { TokenModule } from '../auth/token.module';

@Module({
  imports: [AuthModule, TokenModule],
  controllers: [MfaController],
  providers: [MfaService],
  exports: [MfaService],
})
export class MfaModule {}
