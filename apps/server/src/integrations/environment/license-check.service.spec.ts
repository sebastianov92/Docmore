import {
  DOCMORE_FEATURES,
  EE_PREVIEW_FEATURES,
  LicenseCheckService,
} from './license-check.service';

function makeService(preview: boolean) {
  const moduleRef = {
    get: () => {
      throw new Error('EE module is not installed');
    },
  };
  const environmentService = {
    isCloud: () => false,
    isEePreview: () => preview,
  };
  return new LicenseCheckService(moduleRef as any, environmentService as any);
}

describe('LicenseCheckService without the EE module', () => {
  it('reports the free tier plus the Docmore built-in features by default', () => {
    const service = makeService(false);

    expect(service.resolveTier(null, null)).toBe('free');
    expect(service.resolveFeatures(null, null)).toEqual([...DOCMORE_FEATURES]);
    expect(service.hasFeature(null, 'mfa')).toBe(true);
    expect(service.hasFeature(null, 'api:keys')).toBe(true);
    expect(service.hasFeature(null, 'sso:custom')).toBe(true);
    expect(service.hasFeature(null, 'spaces:personal')).toBe(true);
    expect(service.hasFeature(null, 'comment:resolution')).toBe(true);
    expect(service.hasFeature(null, 'attachment:indexing')).toBe(true);
    expect(service.hasFeature(null, 'import:docx')).toBe(true);
    expect(service.hasFeature(null, 'import:pdf')).toBe(true);
    expect(service.hasFeature(null, 'audit:logs')).toBe(true);
    expect(service.hasFeature(null, 'siem')).toBe(false);
    expect(service.hasFeature(null, 'import:confluence')).toBe(false);
    expect(service.hasFeature(null, 'scim')).toBe(false);
    expect(service.isValidEELicense(null)).toBe(false);
  });

  it('reports every known feature when DOCMORE_PREVIEW_EE is on', () => {
    const service = makeService(true);

    expect(service.resolveTier(null, null)).toBe('enterprise');
    expect(service.resolveFeatures(null, null)).toEqual([...EE_PREVIEW_FEATURES]);
    expect(service.hasFeature(null, 'mfa')).toBe(true);
    expect(service.hasFeature(null, 'not:a:feature')).toBe(false);
    expect(service.isValidEELicense(null)).toBe(true);
  });

  it('covers every feature key the client knows', () => {
    const fs = require('fs');
    const path = require('path');
    const clientFeatures = fs.readFileSync(
      path.resolve(__dirname, '../../../../client/src/ee/features.ts'),
      'utf8',
    );
    const keys = [...clientFeatures.matchAll(/'([a-z:-]+)'/g)].map((m) => m[1]);

    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(EE_PREVIEW_FEATURES).toContain(key);
    }
  });
});
