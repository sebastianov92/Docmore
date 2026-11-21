import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';
import { ClientBundleService } from './client-bundle.service';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import { CollaborationModule } from '../../collaboration/collaboration.module';

@Module({
  imports: [CollaborationModule],
  controllers: [SyncController],
  providers: [
    SyncService,
    ClientBundleService,
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  ],
  exports: [SyncService],
})
export class SyncModule {}
