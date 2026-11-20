import { Test, TestingModule } from '@nestjs/testing';
import { GroupController } from './group.controller';
import { GroupService } from './services/group.service';

describe('GroupController', () => {
  let controller: GroupController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [GroupController],
      providers: [GroupService],
    })
      // every dependency not declared above is a plain mock
      .useMocker(() => ({}))
      .compile();

    controller = module.get<GroupController>(GroupController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
