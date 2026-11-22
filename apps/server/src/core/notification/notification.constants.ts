export const NotificationType = {
  BASE_AUTOMATION: 'base.automation',
  COMMENT_USER_MENTION: 'comment.user_mention',
  COMMENT_CREATED: 'comment.created',
  COMMENT_RESOLVED: 'comment.resolved',
  PAGE_USER_MENTION: 'page.user_mention',
  PAGE_PERMISSION_GRANTED: 'page.permission_granted',
  PAGE_UPDATED: 'page.updated',
  PAGE_VERIFICATION_EXPIRING: 'page.verification_expiring',
  PAGE_VERIFICATION_EXPIRED: 'page.verification_expired',
  PAGE_VERIFIED: 'page.verified',
  PAGE_APPROVAL_REQUESTED: 'page.approval_requested',
  PAGE_APPROVAL_REJECTED: 'page.approval_rejected',
  PAGE_VERIFICATION_INVALIDATED: 'page.verification_invalidated',
  SIEM_DESTINATION_FAILING: 'siem_destination.failing',
  SIEM_DESTINATION_DISABLED: 'siem_destination.disabled',
  SIEM_DESTINATION_RECOVERED: 'siem_destination.recovered',
  BASE_IMPORT_COMPLETED: 'base.import_completed',
  BASE_IMPORT_FAILED: 'base.import_failed',
  AI_RESEARCH_COMPLETED: 'ai.research_completed',
  AI_MEETING_NOTES_READY: 'ai.meeting_notes_ready',
  AI_MEETING_NOTES_FAILED: 'ai.meeting_notes_failed',
  AI_AGENT_RUN_COMPLETED: 'ai.agent_run_completed',
  AI_AGENT_RUN_FAILED: 'ai.agent_run_failed',
  PAGE_SUGGESTION_CREATED: 'page.suggestion_created',
  PAGE_SUGGESTION_ACCEPTED: 'page.suggestion_accepted',
  PAGE_SUGGESTION_REJECTED: 'page.suggestion_rejected',
} as const;

export type NotificationType =
  (typeof NotificationType)[keyof typeof NotificationType];

export type NotificationSettingKey =
  | 'page.updated'
  | 'page.userMention'
  | 'comment.userMention'
  | 'comment.created'
  | 'comment.resolved';

export const NotificationTypeToSettingKey: Partial<
  Record<NotificationType, NotificationSettingKey>
> = {
  [NotificationType.PAGE_UPDATED]: 'page.updated',
  [NotificationType.PAGE_USER_MENTION]: 'page.userMention',
  [NotificationType.COMMENT_USER_MENTION]: 'comment.userMention',
  [NotificationType.COMMENT_CREATED]: 'comment.created',
  [NotificationType.COMMENT_RESOLVED]: 'comment.resolved',
};

export type NotificationTab = 'direct' | 'updates' | 'all';

export const DIRECT_NOTIFICATION_TYPES: NotificationType[] = [
  NotificationType.COMMENT_USER_MENTION,
  NotificationType.COMMENT_CREATED,
  NotificationType.COMMENT_RESOLVED,
  NotificationType.PAGE_USER_MENTION,
  NotificationType.PAGE_PERMISSION_GRANTED,
  NotificationType.SIEM_DESTINATION_FAILING,
  NotificationType.SIEM_DESTINATION_DISABLED,
  NotificationType.SIEM_DESTINATION_RECOVERED,
  NotificationType.BASE_IMPORT_COMPLETED,
  NotificationType.BASE_IMPORT_FAILED,
  NotificationType.AI_RESEARCH_COMPLETED,
  NotificationType.AI_MEETING_NOTES_READY,
  NotificationType.AI_MEETING_NOTES_FAILED,
  NotificationType.AI_AGENT_RUN_COMPLETED,
  NotificationType.AI_AGENT_RUN_FAILED,
  NotificationType.PAGE_SUGGESTION_CREATED,
  NotificationType.PAGE_SUGGESTION_ACCEPTED,
  NotificationType.PAGE_SUGGESTION_REJECTED,
];

export const UPDATES_NOTIFICATION_TYPES: NotificationType[] = [
  NotificationType.PAGE_UPDATED,
];

export function getTypesForTab(tab: NotificationTab): NotificationType[] | undefined {
  if (tab === 'direct') return DIRECT_NOTIFICATION_TYPES;
  if (tab === 'updates') return UPDATES_NOTIFICATION_TYPES;
  return undefined;
}
