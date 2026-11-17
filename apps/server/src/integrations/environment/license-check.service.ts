import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { EnvironmentService } from './environment.service';
import { Feature } from '../../common/features';

// Every feature key the server knows. Used only by DOCMORE_PREVIEW_EE to render
// the EE screens for development and testing; see EnvironmentService.isEePreview.
export const EE_PREVIEW_FEATURES: readonly string[] = Object.values(Feature);

// Features Docmore implements under AGPL outside ee/. Always licensed.
export const DOCMORE_FEATURES: readonly string[] = [
  Feature.API_KEYS,
  Feature.MFA,
  Feature.TEMPLATES,
  Feature.DOCX_EXPORT,
];

function withDocmoreFeatures(features: readonly string[]): string[] {
  return [...new Set([...DOCMORE_FEATURES, ...features])];
}

@Injectable()
export class LicenseCheckService {
  constructor(
    private moduleRef: ModuleRef,
    private environmentService: EnvironmentService,
  ) {}

  isValidEELicense(licenseKey: string): boolean {
    if (this.environmentService.isCloud()) {
      return true;
    }
    if (this.environmentService.isEePreview()) {
      return true;
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const LicenseModule = require('../../ee/licence/license.service');
      const licenseService = this.moduleRef.get(LicenseModule.LicenseService, {
        strict: false,
      });
      return licenseService.isValidEELicense(licenseKey);
    } catch {
      return false;
    }
  }

  hasFeature(licenseKey: string, feature: string, plan?: string): boolean {
    if (DOCMORE_FEATURES.includes(feature)) {
      return true;
    }
    if (this.environmentService.isEePreview()) {
      return EE_PREVIEW_FEATURES.includes(feature);
    }
    if (this.environmentService.isCloud()) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { getFeaturesForCloudPlan } = require('../../ee/licence/feature-registry');
        return getFeaturesForCloudPlan(plan).has(feature);
      } catch {
        return false;
      }
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const LicenseModule = require('../../ee/licence/license.service');
      const licenseService = this.moduleRef.get(LicenseModule.LicenseService, {
        strict: false,
      });
      return licenseService.hasFeature(licenseKey, feature);
    } catch {
      return false;
    }
  }

  getFeatures(licenseKey: string): string[] {
    if (this.environmentService.isEePreview()) {
      return [...EE_PREVIEW_FEATURES];
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const LicenseModule = require('../../ee/licence/license.service');
      const licenseService = this.moduleRef.get(LicenseModule.LicenseService, {
        strict: false,
      });
      return withDocmoreFeatures(licenseService.getFeatures(licenseKey));
    } catch {
      return [...DOCMORE_FEATURES];
    }
  }

  resolveFeatures(licenseKey: string, plan: string): string[] {
    if (this.environmentService.isEePreview()) {
      return [...EE_PREVIEW_FEATURES];
    }
    if (this.environmentService.isCloud()) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { getFeaturesForCloudPlan } = require('../../ee/licence/feature-registry');
        return withDocmoreFeatures([...getFeaturesForCloudPlan(plan)]);
      } catch {
        return [...DOCMORE_FEATURES];
      }
    }

    return this.getFeatures(licenseKey);
  }

  resolveTier(licenseKey: string, plan: string): string {
    if (this.environmentService.isEePreview()) {
      return 'enterprise';
    }
    if (this.environmentService.isCloud()) {
      return plan ?? 'standard';
    }

    return this.getLicenseType(licenseKey) ?? 'free';
  }

  private getLicenseType(licenseKey: string): string | null {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const LicenseModule = require('../../ee/licence/license.service');
      const licenseService = this.moduleRef.get(LicenseModule.LicenseService, {
        strict: false,
      });
      return licenseService.getLicenseType(licenseKey);
    } catch {
      return null;
    }
  }
}
