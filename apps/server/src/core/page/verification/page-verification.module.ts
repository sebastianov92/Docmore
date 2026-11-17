import { Module } from '@nestjs/common';
import { CollaborationModule } from '../../../collaboration/collaboration.module';
import { PageVerificationRepo } from './page-verification.repo';
import { PageVerificationService } from './page-verification.service';
import { PageVerificationController } from './page-verification.controller';
import { PageVerificationSchedulerService } from './page-verification-scheduler.service';

// Page verification without the enterprise module: the endpoints the
// editor calls, the verifier bookkeeping and the expiry sweep. The
// invalidation-on-edit side already lives in PageVerificationInvalidationModule.
@Module({
  imports: [CollaborationModule],
  controllers: [PageVerificationController],
  providers: [PageVerificationRepo, PageVerificationService, PageVerificationSchedulerService],
  exports: [PageVerificationService],
})
export class PageVerificationModule {}
