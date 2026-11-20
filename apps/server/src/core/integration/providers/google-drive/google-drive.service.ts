import { Injectable } from '@nestjs/common';
import { ProviderAccount, UnfurlResult } from '../../registry/integration-provider.interface';
import { providerApiFetch } from '../../utils/provider-fetch';
import { toProviderAccount } from '../../utils/integration.utils';

const MIME_LABELS: Record<string, string> = {
  'application/vnd.google-apps.document': 'Google Doc',
  'application/vnd.google-apps.spreadsheet': 'Google Sheet',
  'application/vnd.google-apps.presentation': 'Google Slides',
  'application/vnd.google-apps.form': 'Google Form',
  'application/vnd.google-apps.folder': 'Folder',
  'application/pdf': 'PDF',
};

@Injectable()
export class GoogleDriveService {
  async getAccount(accessToken: string): Promise<ProviderAccount> {
    const me = await this.get(accessToken, 'https://www.googleapis.com/oauth2/v3/userinfo');
    return toProviderAccount({ id: me.sub, displayName: me.name, username: me.email });
  }

  async unfurlFile(accessToken: string, fileId: string, url: string): Promise<UnfurlResult> {
    const file = await this.get(
      accessToken,
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?supportsAllDrives=true&fields=id,name,mimeType,owners(displayName,photoLink),modifiedTime,webViewLink,iconLink,thumbnailLink`,
    );
    const kind = MIME_LABELS[file.mimeType] ?? (typeof file.mimeType === 'string' ? file.mimeType.split('/').pop() : 'File');
    return {
      title: file.name ?? 'Untitled',
      description: kind,
      url: file.webViewLink ?? url,
      provider: 'google_drive',
      providerIcon: 'google_drive',
      author: file.owners?.[0]?.displayName,
      authorAvatarUrl: file.owners?.[0]?.photoLink,
      metadata: { mimeType: file.mimeType, modifiedTime: file.modifiedTime, iconLink: file.iconLink, thumbnailLink: file.thumbnailLink, kind },
    };
  }

  private async get(accessToken: string, url: string): Promise<any> {
    const response = await providerApiFetch('Google Drive', url, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    return response.json();
  }
}
