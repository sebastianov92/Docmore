import { Test, TestingModule } from '@nestjs/testing';
import { SpaceController } from './space.controller';
import { SpaceService } from './services/space.service';

describe('SpaceController', () => {
  let controller: SpaceController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [SpaceController],
      providers: [SpaceService],
    })
      // every dependency not declared above is a plain mock
      .useMocker(() => ({}))
      .compile();

    controller = module.get<SpaceController>(SpaceController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
