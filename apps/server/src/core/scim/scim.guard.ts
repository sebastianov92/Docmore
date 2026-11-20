import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ScimTokenService } from './scim-token.service';

// Authenticates /scim/v2 with a workspace SCIM token; SCIM must be on.
@Injectable()
export class ScimGuard implements CanActivate {
  constructor(private readonly tokens: ScimTokenService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const workspace = request.raw?.workspace ?? request?.user?.workspace;
    if (!workspace) throw new UnauthorizedException('Unknown workspace');
    if (!workspace.isScimEnabled) throw new UnauthorizedException('SCIM is turned off for this workspace');
    const header: string = request.headers?.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token || !(await this.tokens.verify(token, workspace.id))) throw new UnauthorizedException('Invalid SCIM token');
    return true;
  }
}
