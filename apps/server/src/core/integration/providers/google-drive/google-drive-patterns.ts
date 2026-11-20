import { UnfurlPattern } from '../../registry/integration-provider.interface';

// Drive files, Docs / Sheets / Slides / Forms, and folders.
export const googleDrivePatterns: UnfurlPattern[] = [
  { regex: /^https?:\/\/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]{10,})/, type: 'google-drive-file' },
  { regex: /^https?:\/\/docs\.google\.com\/(document|spreadsheets|presentation|forms)\/d\/([A-Za-z0-9_-]{10,})/, type: 'google-drive-doc' },
  { regex: /^https?:\/\/drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\/([A-Za-z0-9_-]{10,})/, type: 'google-drive-folder' },
];
