import { Test, TestingModule } from '@nestjs/testing';
import { GroupService } from './group.service';

describe('GroupService', () => {
  let service: GroupService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [GroupService],
    })
      // every dependency not declared above is a plain mock
      .useMocker(() => ({}))
      .compile();

    service = module.get<GroupService>(GroupService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
