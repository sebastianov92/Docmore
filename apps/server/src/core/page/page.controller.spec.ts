import { Test, TestingModule } from '@nestjs/testing';
import { PageController } from './page.controller';
import { PageService } from './services/page.service';

describe('PageController', () => {
  let controller: PageController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PageController],
      providers: [PageService],
    })
      // every dependency not declared above is a plain mock
      .useMocker(() => ({}))
      .compile();

    controller = module.get<PageController>(PageController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
