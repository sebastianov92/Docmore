import { Module } from '@nestjs/common';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import { PublicSpaceModule } from '../public-space/public-space.module';
import { ShareModule } from '../share/share.module';
import { AttachmentModule } from '../attachment/attachment.module';
import { SearchAttachmentController } from './search-attachment.controller';
import { SearchAttachmentService } from './search-attachment.service';

@Module({
  imports: [PublicSpaceModule, ShareModule, AttachmentModule],
  controllers: [SearchController, SearchAttachmentController],
  providers: [SearchService, SearchAttachmentService],
  exports: [SearchService],
})
export class SearchModule {}
