import { UnfurlPattern } from '../../registry/integration-provider.interface';

// Jira Cloud issue links: /browse/KEY-123 and boards with a selected issue.
export const jiraPatterns: UnfurlPattern[] = [
  {
    regex: /^https?:\/\/([a-z0-9-]+\.atlassian\.net)\/browse\/([A-Za-z][A-Za-z0-9_]*-\d+)/i,
    type: 'jira-issue',
  },
  {
    regex: /^https?:\/\/([a-z0-9-]+\.atlassian\.net)\/jira\/[^?#]*[?&]selectedIssue=([A-Za-z][A-Za-z0-9_]*-\d+)/i,
    type: 'jira-issue',
  },
];
