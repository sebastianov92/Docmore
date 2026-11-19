import { Module } from '@nestjs/common';
import { SpaceService } from './services/space.service';
import { SpaceController } from './space.controller';
import { SpaceMemberService } from './services/space-member.service';
import { PersonalSpaceService } from './services/personal-space.service';
import { PersonalSpaceController } from './personal-space.controller';
import { SpaceJoinService } from './services/space-join.service';

@Module({
  imports: [],
  controllers: [SpaceController, PersonalSpaceController],
  providers: [
    SpaceService,
    SpaceMemberService,
    PersonalSpaceService,
    SpaceJoinService,
  ],
  exports: [SpaceService, SpaceMemberService],
})
export class SpaceModule {}
