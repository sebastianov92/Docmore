export const PERSONAL_SPACE_DEFAULT_NAME = 'Personal space';
export const PERSONAL_SPACE_SLUG_MAX = 40;

// Turns a space name into a slug the CreateSpaceDto rules accept:
// starts with a letter or digit, then letters, digits, "-" or "_".
export function personalSpaceSlug(name: string): string {
  const ascii = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, PERSONAL_SPACE_SLUG_MAX)
    .replace(/[-_]+$/g, '');
  return ascii.length >= 2 ? ascii : 'personal';
}

// Short random tail so two members with the same name get distinct slugs.
export function slugSuffix(length = 4): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < length; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}
