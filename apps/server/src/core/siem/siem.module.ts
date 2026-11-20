import { Module } from '@nestjs/common';
import { NotificationModule } from '../notification/notification.module';
import { SiemService } from './siem.service';
import { SiemController } from './siem.controller';

@Module({
  imports: [NotificationModule],
  controllers: [SiemController],
  providers: [SiemService],
})
export class SiemModule {}
