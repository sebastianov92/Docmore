import { Module, OnModuleInit } from '@nestjs/common';
import { GoogleDriveProvider } from './google-drive.provider';
import { GoogleDriveService } from './google-drive.service';
import { IntegrationRegistry } from '../../registry/integration-registry';
import { IntegrationModule } from '../../integration.module';

@Module({
  imports: [IntegrationModule],
  providers: [GoogleDriveProvider, GoogleDriveService],
  exports: [GoogleDriveProvider],
})
export class GoogleDriveModule implements OnModuleInit {
  constructor(
    private readonly registry: IntegrationRegistry,
    private readonly provider: GoogleDriveProvider,
  ) {}

  onModuleInit() {
    this.registry.register(this.provider);
  }
}
