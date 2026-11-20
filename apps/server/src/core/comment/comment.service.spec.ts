import { Test, TestingModule } from '@nestjs/testing';
import { CommentService } from './comment.service';

describe('CommentService', () => {
  let service: CommentService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [CommentService],
    })
      // every dependency not declared above is a plain mock
      .useMocker(() => ({}))
      .compile();

    service = module.get<CommentService>(CommentService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
