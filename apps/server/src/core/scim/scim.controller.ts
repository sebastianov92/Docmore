import { Body, Controller, Delete, Get, HttpCode, HttpException, HttpStatus, Param, Patch, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { Workspace } from '@docmost/db/types/entity.types';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { ScimGuard } from './scim.guard';
import { ScimService, SCIM_GROUP_SCHEMA, SCIM_USER_SCHEMA } from './scim.service';

const SCIM_JSON = 'application/scim+json';

// SCIM 2.0 endpoints for identity providers (Okta, Entra ID, JumpCloud…).
@UseGuards(ScimGuard)
@Controller('scim/v2')
export class ScimController {
  constructor(
    private readonly scim: ScimService,
    private readonly environment: EnvironmentService,
  ) {}

  private base(): string {
    return `${this.environment.getAppUrl().replace(/\/+$/, '')}/api/scim/v2`;
  }

  private async respond(res: FastifyReply, status: number, work: () => Promise<unknown>) {
    try {
      const body = await work();
      res.status(status).header('content-type', SCIM_JSON);
      return res.send(body === undefined ? '' : JSON.stringify(body));
    } catch (err) {
      const code = err instanceof HttpException ? err.getStatus() : 500;
      const detail = err instanceof HttpException ? err.message : 'Internal error';
      res.status(code).header('content-type', SCIM_JSON);
      return res.send(JSON.stringify({ schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], status: String(code), detail }));
    }
  }

  @Get('ServiceProviderConfig')
  async config(@Res() res: FastifyReply) {
    return this.respond(res, 200, async () => ({
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: 200 },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [{ type: 'oauthbearertoken', name: 'OAuth Bearer Token', description: 'A SCIM token from Docmore settings' }],
    }));
  }

  @Get('ResourceTypes')
  async resourceTypes(@Res() res: FastifyReply) {
    const base = this.base();
    return this.respond(res, 200, async () => ({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
      totalResults: 2,
      Resources: [
        { schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'], id: 'User', name: 'User', endpoint: '/Users', schema: SCIM_USER_SCHEMA, meta: { location: `${base}/ResourceTypes/User`, resourceType: 'ResourceType' } },
        { schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'], id: 'Group', name: 'Group', endpoint: '/Groups', schema: SCIM_GROUP_SCHEMA, meta: { location: `${base}/ResourceTypes/Group`, resourceType: 'ResourceType' } },
      ],
    }));
  }

  @Get('Schemas')
  async schemas(@Res() res: FastifyReply) {
    return this.respond(res, 200, async () => ({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
      totalResults: 2,
      Resources: [
        { id: SCIM_USER_SCHEMA, name: 'User', attributes: [{ name: 'userName', type: 'string', required: true, uniqueness: 'server' }, { name: 'active', type: 'boolean' }, { name: 'name', type: 'complex' }, { name: 'emails', type: 'complex', multiValued: true }, { name: 'externalId', type: 'string' }] },
        { id: SCIM_GROUP_SCHEMA, name: 'Group', attributes: [{ name: 'displayName', type: 'string', required: true }, { name: 'members', type: 'complex', multiValued: true }, { name: 'externalId', type: 'string' }] },
      ],
    }));
  }

  @Get('Users')
  async listUsers(@Query('filter') filter: string | undefined, @Query('startIndex') startIndex: string | undefined, @Query('count') count: string | undefined, @AuthWorkspace() workspace: Workspace, @Res() res: FastifyReply) {
    return this.respond(res, 200, () => this.scim.listUsers(workspace.id, filter, Number(startIndex) || 1, Number(count) || 100, this.base()));
  }

  @Get('Users/:id')
  async getUser(@Param('id') id: string, @AuthWorkspace() workspace: Workspace, @Res() res: FastifyReply) {
    return this.respond(res, 200, () => this.scim.getUser(workspace.id, id, this.base()));
  }

  @Post('Users')
  async createUser(@Body() body: any, @AuthWorkspace() workspace: Workspace, @Res() res: FastifyReply) {
    return this.respond(res, 201, () => this.scim.createUser(workspace.id, body, this.base()));
  }

  @Put('Users/:id')
  async replaceUser(@Param('id') id: string, @Body() body: any, @AuthWorkspace() workspace: Workspace, @Res() res: FastifyReply) {
    return this.respond(res, 200, () => this.scim.replaceUser(workspace.id, id, body, this.base()));
  }

  @Patch('Users/:id')
  async patchUser(@Param('id') id: string, @Body() body: any, @AuthWorkspace() workspace: Workspace, @Res() res: FastifyReply) {
    return this.respond(res, 200, () => this.scim.patchUser(workspace.id, id, body, this.base()));
  }

  @Delete('Users/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteUser(@Param('id') id: string, @AuthWorkspace() workspace: Workspace, @Res() res: FastifyReply) {
    return this.respond(res, 204, async () => {
      await this.scim.deleteUser(workspace.id, id);
      return undefined;
    });
  }

  @Get('Groups')
  async listGroups(@Query('filter') filter: string | undefined, @Query('startIndex') startIndex: string | undefined, @Query('count') count: string | undefined, @AuthWorkspace() workspace: Workspace, @Res() res: FastifyReply) {
    return this.respond(res, 200, () => this.scim.listGroups(workspace.id, filter, Number(startIndex) || 1, Number(count) || 100, this.base()));
  }

  @Get('Groups/:id')
  async getGroup(@Param('id') id: string, @AuthWorkspace() workspace: Workspace, @Res() res: FastifyReply) {
    return this.respond(res, 200, () => this.scim.getGroup(workspace.id, id, this.base()));
  }

  @Post('Groups')
  async createGroup(@Body() body: any, @AuthWorkspace() workspace: Workspace, @Res() res: FastifyReply) {
    return this.respond(res, 201, () => this.scim.createGroup(workspace.id, body, this.base()));
  }

  @Put('Groups/:id')
  async replaceGroup(@Param('id') id: string, @Body() body: any, @AuthWorkspace() workspace: Workspace, @Res() res: FastifyReply) {
    return this.respond(res, 200, () => this.scim.replaceGroup(workspace.id, id, body, this.base()));
  }

  @Patch('Groups/:id')
  async patchGroup(@Param('id') id: string, @Body() body: any, @AuthWorkspace() workspace: Workspace, @Res() res: FastifyReply) {
    return this.respond(res, 200, () => this.scim.patchGroup(workspace.id, id, body, this.base()));
  }

  @Delete('Groups/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteGroup(@Param('id') id: string, @AuthWorkspace() workspace: Workspace, @Res() res: FastifyReply, @Req() _req: FastifyRequest) {
    return this.respond(res, 204, async () => {
      await this.scim.deleteGroup(workspace.id, id);
      return undefined;
    });
  }
}
