import { personalSpaceSlug, slugSuffix } from './personal-space.utils';

const SLUG_RULE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

describe('personalSpaceSlug', () => {
  it('lowercases, strips accents and joins words with dashes', () => {
    expect(personalSpaceSlug("Sebastián's space")).toBe('sebastian-s-space');
    expect(personalSpaceSlug('  Ana  María ')).toBe('ana-maria');
  });

  it('always yields something the space slug rule accepts', () => {
    for (const name of ['---', '日本語', 'a', '', '!!x', '_hidden_']) {
      const slug = personalSpaceSlug(name);
      expect(slug).toMatch(SLUG_RULE);
      expect(slug.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('caps the length without leaving a trailing dash', () => {
    const slug = personalSpaceSlug('word '.repeat(30));
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.endsWith('-')).toBe(false);
  });
});

describe('slugSuffix', () => {
  it('produces slug-safe characters of the requested length', () => {
    const suffix = slugSuffix(6);
    expect(suffix).toHaveLength(6);
    expect(`x-${suffix}`).toMatch(SLUG_RULE);
  });
});
