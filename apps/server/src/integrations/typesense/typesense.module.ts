import { Module } from '@nestjs/common';
import { SearchModule } from '../../core/search/search.module';
import { TypesenseService } from './typesense.service';
import { PageIndexService } from './page-index.service';
import { PageSearchService } from './page-search.service';
import { SearchQueueProcessor } from './search-queue.processor';
import { TypesenseController } from './typesense.controller';

// Typesense as the page search engine (SEARCH_DRIVER=typesense). The
// search controller reaches PageSearchService through the module ref.
@Module({
  imports: [SearchModule],
  controllers: [TypesenseController],
  providers: [TypesenseService, PageIndexService, PageSearchService, SearchQueueProcessor],
  exports: [TypesenseService, PageIndexService, PageSearchService],
})
export class TypesenseModule {}
