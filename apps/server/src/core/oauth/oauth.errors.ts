import { HttpException, HttpStatus } from '@nestjs/common';

// RFC 6749 error body: {error, error_description}; clients read both.
export class OAuthError extends HttpException {
  constructor(error: string, description: string, status: HttpStatus = HttpStatus.BAD_REQUEST) {
    super({ error, error_description: description, message: description }, status);
  }
}

export function invalidRequest(description: string) {
  return new OAuthError('invalid_request', description);
}

export function invalidClient(description: string) {
  return new OAuthError('invalid_client', description, HttpStatus.UNAUTHORIZED);
}

export function invalidGrant(description: string) {
  return new OAuthError('invalid_grant', description);
}

export function unsupportedGrant(description: string) {
  return new OAuthError('unsupported_grant_type', description);
}

export function invalidScope(description: string) {
  return new OAuthError('invalid_scope', description);
}
