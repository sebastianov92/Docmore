import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Transform, TransformFnParams } from 'class-transformer';

export const SSO_PROVIDER_TYPES = ['oidc', 'saml'] as const;
export type SsoProviderType = (typeof SSO_PROVIDER_TYPES)[number];

const trim = ({ value }: TransformFnParams) =>
  typeof value === 'string' ? value.trim() : value;

export class ProviderIdDto {
  @IsUUID()
  providerId: string;
}

export class CreateSsoProviderDto {
  @IsIn(SSO_PROVIDER_TYPES, {
    message: 'Only OpenID Connect (oidc) and SAML (saml) providers are supported',
  })
  type: SsoProviderType;

  @IsOptional()
  @IsString()
  @Transform(trim)
  @MinLength(1)
  @MaxLength(100)
  name?: string;
}

export class UpdateSsoProviderDto {
  @IsUUID()
  providerId: string;

  @IsOptional()
  @IsString()
  @Transform(trim)
  @IsNotEmpty()
  @MaxLength(100)
  name?: string;

  // http is accepted for identity providers on a private network.
  @IsOptional()
  @IsString()
  @Transform(trim)
  @IsUrl({
    require_protocol: true,
    require_tld: false,
    protocols: ['http', 'https'],
  })
  @MaxLength(500)
  oidcIssuer?: string;

  @IsOptional()
  @IsString()
  @Transform(trim)
  @IsNotEmpty()
  @MaxLength(500)
  oidcClientId?: string;

  @IsOptional()
  @IsString()
  @Transform(trim)
  @IsNotEmpty()
  @MaxLength(2000)
  oidcClientSecret?: string;

  // SAML: the IdP's single sign-on URL and its signing certificate (PEM or bare base64)
  @IsOptional()
  @IsString()
  @IsUrl({ require_protocol: true, require_tld: false, protocols: ['https', 'http'] })
  samlUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20000)
  samlCertificate?: string;

  @IsOptional()
  @IsBoolean()
  allowSignup?: boolean;

  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  groupSync?: boolean;
}
