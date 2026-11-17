// Shared bits of the Word and PDF importers that need no services.

// Word paragraph styles beyond the headings mammoth already maps.
export const DOCX_STYLE_MAP = [
  "p[style-name='Title'] => h1:fresh",
  "p[style-name='Subtitle'] => h2:fresh",
  "p[style-name='Quote'] => blockquote:fresh",
  "p[style-name='Intense Quote'] => blockquote:fresh",
  "p[style-name='Block Text'] => blockquote:fresh",
  'u => u',
  'strike => s',
  "r[style-name='Code'] => code",
  "p[style-name='Code'] => pre:fresh",
  "p[style-name='Source Code'] => pre:fresh",
];

export const MAX_IMPORTED_IMAGES = 150;
export const MAX_IMPORTED_IMAGE_BYTES = 20 * 1024 * 1024;
// Decorative slivers (rules, bullets rendered as images) are not worth a file.
export const MIN_IMPORTED_IMAGE_SIDE = 16;
export const DEFAULT_IMAGE_WIDTH = 600;

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/bmp': '.bmp',
  'image/x-emf': '',
  'image/x-wmf': '',
  'image/tiff': '',
};

// Extension for an image the editor can show, or null when the browser
// could not render it anyway (EMF, WMF, TIFF).
export function imageExtensionFor(contentType: string | null | undefined): string | null {
  const type = (contentType ?? '').split(';')[0].trim().toLowerCase();
  const ext = IMAGE_EXTENSIONS[type];
  return ext ? ext : null;
}

export function imageFileName(index: number, ext: string): string {
  return `image-${String(index).padStart(3, '0')}${ext}`;
}

export interface ImportedImageRef {
  attachmentId: string;
  apiFilePath: string;
  width: number | null;
  height: number | null;
}

// The editor's image node, as the HTML importer expects it (block level,
// centered, with the attachment id so the file follows the page).
export function imageHtml(image: ImportedImageRef, alt?: string): string {
  const width = image.width ?? DEFAULT_IMAGE_WIDTH;
  const height = image.height ? ` height="${image.height}"` : '';
  const altAttr = alt ? ` alt="${escapeAttribute(alt)}"` : '';
  return `<img src="${image.apiFilePath}" data-attachment-id="${image.attachmentId}" width="${width}"${height} data-align="center"${altAttr}>`;
}

export function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export interface PdfPageText {
  page: number; // 0-indexed, as pdf-inspector reports it
  markdown: string;
  needsOcr: boolean;
}

// Trims each page and drops the ones with nothing usable, keeping order.
export function usablePdfPages(pages: PdfPageText[]): PdfPageText[] {
  return pages
    .map((p) => ({ ...p, markdown: (p.markdown ?? '').replace(/\u0000/g, '').trim() }))
    .filter((p) => p.markdown.length > 0);
}

export function pdfHasText(pages: PdfPageText[]): boolean {
  return usablePdfPages(pages).length > 0;
}
