import { BaseConnectedService } from './connected/base-connected.service';
import { BaseConnectedListener } from './connected/base-connected.listener';
import { IntegrationModule } from '../integration/integration.module';
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { BaseController } from './controllers/base.controller';
import { BasePropertyController } from './controllers/base-property.controller';
import { BaseRowController } from './controllers/base-row.controller';
import { BaseViewController } from './controllers/base-view.controller';
import { BaseService } from './services/base.service';
import { BasePropertyService } from './services/base-property.service';
import { BaseRowService } from './services/base-row.service';
import { BaseViewService } from './services/base-view.service';
import { BaseCsvExportService } from './services/base-csv-export.service';
import { BasePageResolverService } from './services/base-page-resolver.service';
import { BaseQueueProcessor } from './processors/base-queue.processor';
import { BaseWsService } from './realtime/base-ws.service';
import { BaseWsConsumers } from './realtime/base-ws-consumers';
import { BasePresenceService } from './realtime/base-presence.service';
import { QueueName } from '../../integrations/queue/constants';
import { FormulaService } from './formula/formula.service';
import { FormulaLockService } from './formula/formula-lock';
import { PageModule } from '../page/page.module';
import { BaseAuditListener } from './listeners/base-audit.listener';
import { NotificationModule } from '../notification/notification.module';
import { BaseCsvImportService } from './import/base-csv-import.service';
import { BaseImportProcessor } from './processors/base-import.processor';
import { ShareModule } from '../share/share.module';
import { PublicSpaceModule } from '../public-space/public-space.module';
import { BasePublicController } from './controllers/base-public.controller';
import { BaseRowSearchService } from './search/base-row-search.service';
import { BaseRelationService } from './services/base-relation.service';
import { BaseVisibilityService } from './services/base-visibility.service';
import { BaseHistoryService } from './services/base-history.service';
import { BaseRowVersionRepo } from '@docmost/db/repos/base/base-row-version.repo';
import { BaseHistoryController } from './controllers/base-history.controller';
import { BaseAutomationRepo } from '@docmost/db/repos/base/base-automation.repo';
import { BaseAutomationService } from './automation/base-automation.service';
import { BaseAutomationListener } from './automation/base-automation.listener';
import { BaseAutomationController } from './automation/base-automation.controller';
import { BaseFormRepo } from '@docmost/db/repos/base/base-form.repo';
import { BaseFormService } from './forms/base-form.service';
import { BaseFormController, BaseFormPublicController } from './forms/base-form.controller';

@Module({
  imports: [
    BullModule.registerQueue({ name: QueueName.BASE_QUEUE }),
    BullModule.registerQueue({ name: QueueName.BASE_IMPORT_QUEUE }),
    NotificationModule,
    ShareModule,
    PublicSpaceModule,
    PageModule,
    IntegrationModule,
  ],
  controllers: [
    BaseHistoryController,
    BaseAutomationController,
    BaseFormController,
    BaseFormPublicController,
    BaseController,
    BasePropertyController,
    BaseRowController,
    BaseViewController,
    BasePublicController,
  ],
  providers: [
    BaseAutomationRepo,
    BaseAutomationService,
    BaseAutomationListener,
    BaseConnectedService,
    BaseConnectedListener,
    BaseFormRepo,
    BaseFormService,
    BaseVisibilityService,
    BaseHistoryService,
    BaseRowVersionRepo,
    BaseService,
    BasePropertyService,
    BaseRowService,
    BaseViewService,
    BaseRelationService,
    BaseCsvExportService,
    BasePageResolverService,
    BaseQueueProcessor,
    BasePresenceService,
    BaseWsService,
    BaseWsConsumers,
    FormulaService,
    FormulaLockService,
    BaseAuditListener,
    BaseCsvImportService,
    BaseImportProcessor,
    BaseRowSearchService,
  ],
  exports: [
    BaseAutomationService,
    BaseFormService,
    BaseVisibilityService,
    BaseHistoryService,
    BaseRowSearchService,
    BaseService,
    BasePropertyService,
    BaseRowService,
    BaseViewService,
    BaseWsService,
    BasePresenceService,
    FormulaService,
    FormulaLockService,
  ],
})
export class BaseModule {}
