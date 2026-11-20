export interface AiChat {
  id: string;
  workspaceId: string;
  creatorId: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AiChatToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: unknown;
}

export interface AiChatMessage {
  id: string;
  chatId: string;
  role: "user" | "assistant" | "tool";
  content: string | null;
  toolCalls: AiChatToolCall[] | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export type AiChatStreamEvent =
  | { type: "chat_created"; chatId: string }
  | { type: "content"; text: string }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; id: string; result: unknown }
  | { type: "done"; messageId: string; usage?: Record<string, number> }
  | { type: "error"; message: string; code?: string; retryable?: boolean };

export interface PageMention {
  id: string;
  title: string;
  slugId: string;
  spaceSlug?: string;
  icon?: string;
}

export interface ChatAttachment {
  id: string;
  fileName: string;
  fileExt: string;
  fileSize: number;
  mimeType: string;
}

export interface SendChatParams {
  chatId?: string;
  content: string;
  mentionedPageIds?: string[];
  contextPageId?: string;
  attachmentIds?: string[];
  skillId?: string;
}

// What the input adds to a message besides text, pages and files.
export interface SendExtras {
  skillId?: string;
  skillName?: string;
  research?: boolean;
}

// An MCP tool call parked until the person answers.
export interface PendingToolApproval {
  approvalId: string;
  server: string;
  tool: string;
}

export function pendingApprovalOf(call: AiChatToolCall): PendingToolApproval | null {
  const r = call.result as any;
  return r && typeof r === "object" && r.pendingApproval?.approvalId ? (r.pendingApproval as PendingToolApproval) : null;
}

// "mcp__server__tool" -> { server, tool }
export function splitMcpToolName(name: string): { server: string; tool: string } | null {
  const m = /^mcp__([^_].*?)__(.+)$/.exec(name);
  return m ? { server: m[1].replace(/_/g, " "), tool: m[2] } : null;
}

export const MAX_ATTACHMENTS_PER_MESSAGE = 5;
export const CHAT_ACCEPTED_FILES = ".pdf,.docx,.txt,.csv,.md,.png,.jpg,.jpeg,.webp,.gif";
export const CHAT_IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif"];
// The server appends the referenced pages to the stored message; hidden here.
export const REFERENCED_PAGES_RE = /\n\n<referenced_pages>[\s\S]*<\/referenced_pages>$/;
