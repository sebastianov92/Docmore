import { BadRequestException } from '@nestjs/common';
import {
  ANNOUNCEMENT_MAX_TEXT_LENGTH,
  AnnouncementContent,
  AnnouncementMark,
  AnnouncementText,
} from './announcement.constants';

const SAFE_PROTOCOLS = ['https:', 'http:', 'mailto:'];
// Browsers drop tabs and newlines, so "/\t/host" would act as "//host".
const UNSAFE_CHARACTERS = /[\p{Cc}\p{Cs}]/u;

export function isSafeAnnouncementHref(href: unknown): href is string {
  if (typeof href !== 'string') return false;
  const value = href.trim();
  if (!value || UNSAFE_CHARACTERS.test(value)) return false;
  if (value.startsWith('/')) {
    return !value.startsWith('//') && !value.startsWith('/\\');
  }
  try {
    return SAFE_PROTOCOLS.includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

// Keeps exactly what a banner can show: one paragraph of text runs with
// bold, italic, underline and safe links. Anything else is dropped or
// refused, so stored content never carries more than the renderer expects.
export function normalizeAnnouncementContent(input: unknown): {
  content: AnnouncementContent;
  text: string;
} {
  const doc = input as any;
  if (!doc || doc.type !== 'doc' || !Array.isArray(doc.content)) {
    throw new BadRequestException('The announcement message is not valid');
  }
  const paragraphs = doc.content.filter((node: any) => node?.type === 'paragraph');
  if (paragraphs.length !== 1 || doc.content.length !== 1) {
    throw new BadRequestException('The announcement message must be a single paragraph');
  }
  const runs: AnnouncementText[] = [];
  for (const node of paragraphs[0].content ?? []) {
    if (!node || node.type !== 'text' || typeof node.text !== 'string' || !node.text) continue;
    const marks: AnnouncementMark[] = [];
    for (const mark of Array.isArray(node.marks) ? node.marks : []) {
      if (mark?.type === 'bold' || mark?.type === 'italic' || mark?.type === 'underline') {
        if (!marks.some((m) => m.type === mark.type)) marks.push({ type: mark.type });
      } else if (mark?.type === 'link') {
        const href = mark?.attrs?.href;
        if (!isSafeAnnouncementHref(href)) {
          throw new BadRequestException('Links must be http, https, mailto or a path in this app');
        }
        if (!marks.some((m) => m.type === 'link')) marks.push({ type: 'link', attrs: { href: href.trim() } });
      }
    }
    runs.push(marks.length ? { type: 'text', text: node.text, marks } : { type: 'text', text: node.text });
  }
  const text = runs.map((r) => r.text).join('');
  if (!text.trim()) {
    throw new BadRequestException('The announcement message is required');
  }
  if (text.length > ANNOUNCEMENT_MAX_TEXT_LENGTH) {
    throw new BadRequestException(`The announcement message is too long (max ${ANNOUNCEMENT_MAX_TEXT_LENGTH} characters)`);
  }
  return { content: { type: 'doc', content: [{ type: 'paragraph', content: runs }] }, text };
}
