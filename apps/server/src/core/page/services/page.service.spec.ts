import { Test, TestingModule } from '@nestjs/testing';
import { PageService } from './page.service';

describe('PageService', () => {
  let service: PageService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PageService],
    })
      // every dependency not declared above is a plain mock
      .useMocker(() => ({}))
      .compile();

    service = module.get<PageService>(PageService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
