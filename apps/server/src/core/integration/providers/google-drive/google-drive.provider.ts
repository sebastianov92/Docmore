import { Injectable } from '@nestjs/common';
import {
  IntegrationProvider,
  IntegrationDefinition,
  ProviderAccount,
  ResolveAccountOpts,
  UnfurlOpts,
  UnfurlResult,
} from '../../registry/integration-provider.interface';
import { GoogleDriveService } from './google-drive.service';
import { googleDrivePatterns } from './google-drive-patterns';

// Google Drive, Docs, Sheets and Slides previews. Credentials:
// INTEGRATION_GOOGLE_CLIENT_ID / INTEGRATION_GOOGLE_CLIENT_SECRET.
@Injectable()
export class GoogleDriveProvider extends IntegrationProvider {
  definition: IntegrationDefinition = {
    type: 'google_drive',
    name: 'Google Drive',
    description: 'Previews for Drive files, Docs, Sheets, Slides and folders',
    icon: 'google_drive',
    capabilities: ['oauth', 'unfurl'],
    oauth: {
      authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      scopes: ['https://www.googleapis.com/auth/drive.metadata.readonly', 'openid', 'email', 'profile'],
      credentialsKey: 'google',
      authParams: { access_type: 'offline', prompt: 'consent' },
    },
    unfurlPatterns: googleDrivePatterns,
  };

  constructor(private readonly drive: GoogleDriveService) {
    super();
  }

  getUnfurlHosts(): string[] {
    return ['drive.google.com', 'docs.google.com'];
  }

  async resolveAccount(opts: ResolveAccountOpts): Promise<ProviderAccount> {
    return this.drive.getAccount(opts.accessToken);
  }

  async unfurl(opts: UnfurlOpts): Promise<UnfurlResult> {
    const { match, accessToken, url, patternType } = opts;
    const fileId = patternType === 'google-drive-doc' ? match[2] : match[1];
    return this.drive.unfurlFile(accessToken, fileId, url);
  }
}
