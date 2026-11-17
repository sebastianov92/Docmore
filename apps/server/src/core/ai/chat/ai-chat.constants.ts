export const MAX_CHAT_MESSAGE_CHARS = 50_000;
// Messages sent to the model from the chat's history, newest last.
export const MAX_HISTORY_MESSAGES = 30;
// Mentioned and context pages, per page and in total.
export const MAX_CONTEXT_PAGE_CHARS = 20_000;
export const MAX_CONTEXT_TOTAL_CHARS = 60_000;
export const MAX_ATTACHMENT_TEXT_CHARS = 20_000;
export const MAX_ATTACHMENTS_PER_MESSAGE = 5;
export const MAX_CHAT_FILE_BYTES = 20 * 1024 * 1024;
// Tool calls the model may chain in one answer.
export const MAX_TOOL_STEPS = 8;
export const MAX_CHAT_OUTPUT_TOKENS = 4_096;
// What get_page hands the model.
export const MAX_TOOL_PAGE_CHARS = 30_000;
export const MAX_TITLE_CHARS = 60;

export const CHAT_TEXT_EXTENSIONS = ['.pdf', '.docx', '.txt', '.csv', '.md'];
export const CHAT_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
export const CHAT_FILE_EXTENSIONS = [...CHAT_TEXT_EXTENSIONS, ...CHAT_IMAGE_EXTENSIONS];

export const CHAT_TOOL_NAMES = [
  'list_spaces',
  'search_pages',
  'get_page',
  'create_page',
  'update_page',
] as const;
export type ChatToolName = (typeof CHAT_TOOL_NAMES)[number];
