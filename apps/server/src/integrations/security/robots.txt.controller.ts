import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { SkipTransform } from '../../common/decorators/skip-transform.decorator';
import { EnvironmentService } from '../environment/environment.service';

@Controller('robots.txt')
export class RobotsTxtController {
  constructor(private readonly environmentService: EnvironmentService) {}

  @SkipTransform()
  @HttpCode(HttpStatus.OK)
  @Get()
  async robotsTxt() {
    const base = this.environmentService.getAppUrl().replace(/\/$/, '');
    return [
      'User-Agent: *',
      'Disallow: /login',
      'Disallow: /forgot-password',
      'Disallow: /api/',
      `Sitemap: ${base}/sitemap.xml`,
    ].join('\n');
  }
}
