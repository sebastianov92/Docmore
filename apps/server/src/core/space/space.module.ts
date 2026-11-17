import { Module } from '@nestjs/common';
import { SpaceService } from './services/space.service';
import { SpaceController } from './space.controller';
import { SpaceMemberService } from './services/space-member.service';
import { PersonalSpaceService } from './services/personal-space.service';
import { PersonalSpaceController } from './personal-space.controller';

@Module({
  imports: [],
  controllers: [SpaceController, PersonalSpaceController],
  providers: [SpaceService, SpaceMemberService, PersonalSpaceService],
  exports: [SpaceService, SpaceMemberService],
})
export class SpaceModule {}
