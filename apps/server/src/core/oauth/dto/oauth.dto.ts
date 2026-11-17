import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

// RFC 7591 dynamic client registration body.
export class RegisterClientDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  client_name?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(2000, { each: true })
  redirect_uris: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  grant_types?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  response_types?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(40)
  token_endpoint_auth_method?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  client_uri?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  logo_uri?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  scope?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  software_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  software_version?: string;
}

// The authorization request as the consent page received it.
export class AuthorizeParamsDto {
  @IsOptional()
  @IsString()
  @MaxLength(40)
  response_type?: string;

  @IsString()
  @MaxLength(200)
  client_id: string;

  @IsString()
  @MaxLength(2000)
  redirect_uri: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  state?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  code_challenge?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  code_challenge_method?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  scope?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  resource?: string;
}

export class ApproveAuthorizationDto extends AuthorizeParamsDto {
  @IsBoolean()
  approved: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  approvedScopes?: string[];
}

export class TokenRequestDto {
  @IsString()
  @MaxLength(40)
  grant_type: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  code?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  redirect_uri?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  client_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  client_secret?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  code_verifier?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  refresh_token?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  resource?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  scope?: string;
}

export class RevokeTokenDto {
  @IsString()
  @MaxLength(1000)
  token: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  token_type_hint?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  client_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  client_secret?: string;
}

export class GrantIdDto {
  @IsUUID()
  grantId: string;
}
