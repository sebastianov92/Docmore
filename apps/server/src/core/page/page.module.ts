import { Module } from '@nestjs/common';
import { PageService } from './services/page.service';
import { PageController } from './page.controller';
import { NotificationModule } from '../notification/notification.module';
import { PageSuggestionController } from './suggestions/page-suggestion.controller';
import { PageSuggestionService } from './suggestions/page-suggestion.service';
import { PageHistoryService } from './services/page-history.service';
import { TrashCleanupService } from './services/trash-cleanup.service';
import { BacklinkService } from './services/backlink.service';
import { StorageModule } from '../../integrations/storage/storage.module';
import { CollaborationModule } from '../../collaboration/collaboration.module';
import { WatcherModule } from '../watcher/watcher.module';
import { TransclusionModule } from './transclusion/transclusion.module';
import { LabelModule } from '../label/label.module';
import { ShareModule } from '../share/share.module';
import { UnsplashModule } from '../../integrations/unsplash/unsplash.module';
import { PageVerificationInvalidationModule } from './verification/page-verification-invalidation.module';

@Module({
  controllers: [PageController, PageSuggestionController],
  providers: [
    PageSuggestionService,
    PageService,
    PageHistoryService,
    TrashCleanupService,
    BacklinkService,
  ],
  exports: [PageService, PageHistoryService],
  imports: [NotificationModule, 
    StorageModule,
    CollaborationModule,
    WatcherModule,
    TransclusionModule,
    LabelModule,
    ShareModule,
    UnsplashModule,
    PageVerificationInvalidationModule,
  ],
})
export class PageModule {}
