import { Module } from '@nestjs/common';
import { PageModule } from '../page/page.module';
import { ClipperController } from './clipper.controller';
import { ClipperService } from './clipper.service';

@Module({
  imports: [PageModule],
  controllers: [ClipperController],
  providers: [ClipperService],
})
export class ClipperModule {}
