import { Injectable } from '@nestjs/common';
import {
  IntegrationProvider,
  IntegrationDefinition,
  ProviderAccount,
  ResolveAccountOpts,
  UnfurlOpts,
  UnfurlResult,
} from '../../registry/integration-provider.interface';
import { JiraService } from './jira.service';
import { jiraPatterns } from './jira-patterns';

// Jira Cloud through Atlassian OAuth 2.0 (3LO). Credentials:
// INTEGRATION_ATLASSIAN_CLIENT_ID / INTEGRATION_ATLASSIAN_CLIENT_SECRET.
@Injectable()
export class JiraProvider extends IntegrationProvider {
  definition: IntegrationDefinition = {
    type: 'jira',
    name: 'Jira',
    description: 'Issue previews for Jira Cloud links',
    icon: 'jira',
    capabilities: ['oauth', 'unfurl'],
    oauth: {
      authUrl: 'https://auth.atlassian.com/authorize',
      tokenUrl: 'https://auth.atlassian.com/oauth/token',
      scopes: ['read:jira-work', 'read:jira-user', 'read:me', 'offline_access'],
      credentialsKey: 'atlassian',
      authParams: { audience: 'api.atlassian.com', prompt: 'consent' },
    },
    unfurlPatterns: jiraPatterns,
  };

  constructor(private readonly jira: JiraService) {
    super();
  }

  getUnfurlHosts(): string[] {
    return ['*.atlassian.net'];
  }

  async resolveAccount(opts: ResolveAccountOpts): Promise<ProviderAccount> {
    return this.jira.getAccount(opts.accessToken);
  }

  async unfurl(opts: UnfurlOpts): Promise<UnfurlResult> {
    const { match, accessToken, url } = opts;
    return this.jira.unfurlIssue(accessToken, match[1], match[2], url);
  }
}
