import { Injectable } from '@nestjs/common';
import { ProviderAccount, UnfurlResult } from '../../registry/integration-provider.interface';
import { providerApiFetch } from '../../utils/provider-fetch';
import { toProviderAccount } from '../../utils/integration.utils';

const ATLASSIAN_API = 'https://api.atlassian.com';

const STATUS_COLORS: Record<string, string> = { new: 'gray', indeterminate: 'blue', done: 'green', undefined: 'gray' };

@Injectable()
export class JiraService {
  async getAccount(accessToken: string): Promise<ProviderAccount> {
    const me = await this.get(accessToken, `${ATLASSIAN_API}/me`);
    return toProviderAccount({ id: me.account_id, displayName: me.name, username: me.email });
  }

  // Resolves the site (cloud id) from the link's host, then reads the issue.
  async unfurlIssue(accessToken: string, host: string, key: string, url: string): Promise<UnfurlResult> {
    const sites: Array<{ id: string; url: string; name: string }> = await this.get(accessToken, `${ATLASSIAN_API}/oauth/token/accessible-resources`);
    const site = sites.find((s) => safeHost(s.url) === host.toLowerCase()) ?? sites[0];
    if (!site) throw new Error('No Jira site is connected for this account');
    const issue = await this.get(accessToken, `${ATLASSIAN_API}/ex/jira/${site.id}/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,status,assignee,issuetype,priority,updated`);
    const f = issue.fields ?? {};
    return {
      title: `${issue.key} ${f.summary ?? ''}`.trim(),
      description: [f.issuetype?.name, site.name].filter(Boolean).join(' · '),
      url,
      provider: 'jira',
      providerIcon: 'jira',
      status: f.status?.name,
      statusColor: STATUS_COLORS[f.status?.statusCategory?.key ?? 'undefined'] ?? 'gray',
      author: f.assignee?.displayName,
      authorAvatarUrl: f.assignee?.avatarUrls?.['24x24'],
      metadata: { key: issue.key, priority: f.priority?.name, issueType: f.issuetype?.name, updated: f.updated, siteName: site.name },
    };
  }

  private async get(accessToken: string, url: string): Promise<any> {
    const response = await providerApiFetch('Jira', url, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    return response.json();
  }
}

function safeHost(u: string): string {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return '';
  }
}
