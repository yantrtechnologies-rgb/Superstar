import { type CanActivate, type ExecutionContext, ForbiddenException, HttpException, Injectable, SetMetadata, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type ApiScope, apiKeyPattern, workspaceSlug } from '@cadencedesk/contracts';
import { resolveApiKey } from '@cadencedesk/data';
import { ApiRateLimit } from './api-rate-limit';

const scopeMetadata = 'cadencedesk.api.scope';

export const RequireApiScope = (scope: ApiScope) => SetMetadata(scopeMetadata, scope);

type KeyPrincipal = {
  keyId: string;
  actorId: string;
  workspaceId: string;
  slug: string;
};

export type KeyRequest = {
  headers: Record<string, string | string[] | undefined>;
  params: Record<string, string | undefined>;
  principal: KeyPrincipal;
};

type ApiResponse = { setHeader(name: string, value: number | string): void };

@Injectable()
export class WorkspaceApiGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly rateLimit: ApiRateLimit) {}

  async canActivate(context: ExecutionContext) {
    const http = context.switchToHttp();
    const response = http.getResponse<ApiResponse>();
    response.setHeader('Cache-Control', 'no-store');
    const req = http.getRequest<KeyRequest>();
    const scope = this.reflector.get<ApiScope>(scopeMetadata, context.getHandler());
    const slug = workspaceSlug.safeParse(req.params.workspace);
    const header = req.headers.authorization;
    const token = typeof header === 'string' ? /^Bearer (\S+)$/i.exec(header)?.[1] : undefined;
    const unavailable = () => {
      response.setHeader('WWW-Authenticate', 'Bearer');
      throw new UnauthorizedException('A valid workspace API key is required.');
    };
    if (!scope || !slug.success || !token || !apiKeyPattern.test(token)) return unavailable();
    const key = await resolveApiKey(token, slug.data);
    if (!key) return unavailable();
    const rate = await this.rateLimit.consume(key.id);
    response.setHeader('X-RateLimit-Limit', rate.limit);
    response.setHeader('X-RateLimit-Remaining', rate.remaining);
    response.setHeader('X-RateLimit-Reset', rate.resetsIn);
    if (!rate.allowed) {
      response.setHeader('Retry-After', rate.resetsIn);
      throw new HttpException('API rate limit reached.', 429);
    }
    if (!key.scopes.includes(scope)) throw new ForbiddenException('The API key lacks the required scope.');
    req.principal = { keyId: key.id, actorId: key.createdById, workspaceId: key.workspaceId, slug: slug.data };
    return true;
  }
}
