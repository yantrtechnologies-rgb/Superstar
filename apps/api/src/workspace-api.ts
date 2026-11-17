import {
  BadRequestException, Body, ConflictException, Controller, Get, Headers, HttpCode, InternalServerErrorException, NotFoundException,
  Param, Post, Query, Req, UseGuards, applyDecorators,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiHeader, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { apiChannelPage, apiPostPage, apiPostResource, createDraftInput, pageInput, scheduleRevisionInput, submitRevisionInput } from '@cadencedesk/contracts';
import {
  apiChannels, apiPost, apiPosts, cancelPost, DraftRequestConflictError, ProviderConfigurationError,
  savePost, schedulePost, transitionPost, WorkspaceAccessError,
} from '@cadencedesk/data';
import { z } from 'zod';
import { type KeyRequest, RequireApiScope, WorkspaceApiGuard } from './workspace-api-guard';

function validated<T>(schema: z.ZodType<T>, input: unknown) {
  const result = schema.safeParse(input);
  if (!result.success) throw new BadRequestException({
    message: 'Invalid request.',
    fields: result.error.issues.map(({ path, message }) => ({ field: path.join('.'), message })),
  });
  return result.data;
}

function BodySchema(schema: z.ZodType) {
  return ApiBody({ schema: z.toJSONSchema(schema, { target: 'openapi-3.0' }) } as Parameters<typeof ApiBody>[0]);
}

function JsonResponse(status: number, schema: z.ZodType) {
  return ApiResponse({ status, schema: z.toJSONSchema(schema, { target: 'openapi-3.0' }) } as Parameters<typeof ApiResponse>[0]);
}

function PageQuery() {
  return applyDecorators(
    ApiQuery({ name: 'limit', required: false, type: Number, description: 'Page size from 1 to 100.' }),
    ApiQuery({ name: 'offset', required: false, type: Number, description: 'Starting position in the result.' }),
  );
}

async function applyCommand<T>(command: () => Promise<T>) {
  try {
    return await command();
  } catch (error) {
    if (error instanceof DraftRequestConflictError || error instanceof WorkspaceAccessError) {
      throw new ConflictException(error.message);
    }
    if (error instanceof ProviderConfigurationError) throw new BadRequestException(error.message);
    if (error instanceof Error && 'code' in error && error.code === 'P2034') {
      throw new ConflictException('The post changed concurrently. Reload it and retry the command.');
    }
    console.error(JSON.stringify({ event: 'workspace_api.command_failed' }));
    throw new InternalServerErrorException('The command could not be completed.');
  }
}

async function scopedPost(workspaceId: string, id: string) {
  const record = await apiPost(workspaceId, id);
  if (!record) throw new NotFoundException('Post unavailable.');
  return record;
}

@ApiTags('Workspace publishing')
@ApiBearerAuth('WorkspaceKey')
@ApiParam({ name: 'workspace', description: 'Workspace slug bound to the API key.' })
@ApiResponse({ status: 401, description: 'Missing, expired, revoked or mismatched workspace key.' })
@ApiResponse({ status: 403, description: 'API key scope is insufficient.' })
@ApiResponse({ status: 429, description: 'API rate limit reached.' })
@Controller('v1/workspaces/:workspace')
@UseGuards(WorkspaceApiGuard)
export class WorkspaceApiController {
  @Get('channels')
  @RequireApiScope('channels:read')
  @ApiOperation({ summary: 'List workspace channels', description: 'Requires channels:read.' })
  @PageQuery()
  @JsonResponse(200, apiChannelPage)
  listChannels(@Req() req: KeyRequest, @Query() query: Record<string, string>) {
    return apiChannels(req.principal.workspaceId, validated(pageInput, query));
  }

  @Get('posts')
  @RequireApiScope('posts:read')
  @ApiOperation({ summary: 'List workspace posts', description: 'Requires posts:read.' })
  @PageQuery()
  @JsonResponse(200, apiPostPage)
  listPosts(@Req() req: KeyRequest, @Query() query: Record<string, string>) {
    return apiPosts(req.principal.workspaceId, validated(pageInput, query));
  }

  @Get('posts/:id')
  @RequireApiScope('posts:read')
  @ApiOperation({ summary: 'Get a workspace post', description: 'Requires posts:read.' })
  @JsonResponse(200, apiPostResource)
  getPost(@Req() req: KeyRequest, @Param('id') id: string) {
    return scopedPost(req.principal.workspaceId, validated(z.uuid(), id));
  }

  @Post('posts')
  @RequireApiScope('posts:write')
  @ApiOperation({ summary: 'Create a text draft', description: 'Requires posts:write.' })
  @ApiHeader({ name: 'Idempotency-Key', required: false, description: 'A UUID to reuse when retrying the same draft request.' })
  @BodySchema(createDraftInput)
  @JsonResponse(201, apiPostResource)
  async createDraft(@Req() req: KeyRequest, @Body() body: unknown, @Headers('idempotency-key') idempotencyKey?: string) {
    const data = validated(createDraftInput, body);
    const key = idempotencyKey === undefined ? undefined : validated(z.uuid(), idempotencyKey);
    const { actorId, workspaceId, slug, keyId } = req.principal;
    const post = await applyCommand(() => savePost(
      actorId, slug, data.content, undefined, undefined, undefined, data.followUp, key ? keyId + ':' + key : undefined,
    ));
    return scopedPost(workspaceId, post.id);
  }

  @Post('posts/:id/review')
  @HttpCode(200)
  @RequireApiScope('posts:write')
  @ApiOperation({ summary: 'Request review for a draft revision', description: 'Requires posts:write.' })
  @BodySchema(submitRevisionInput)
  @JsonResponse(200, apiPostResource)
  async requestReview(@Req() req: KeyRequest, @Param('id') id: string, @Body() body: unknown) {
    const data = validated(submitRevisionInput, body);
    const { actorId, workspaceId, slug } = req.principal;
    const postId = validated(z.uuid(), id);
    await scopedPost(workspaceId, postId);
    await applyCommand(() => transitionPost(actorId, slug, postId, data.revision, 'IN_REVIEW', data.channelIds));
    return scopedPost(workspaceId, postId);
  }

  @Post('posts/:id/schedule')
  @HttpCode(202)
  @RequireApiScope('posts:schedule')
  @ApiOperation({ summary: 'Schedule an approved revision', description: 'Requires posts:schedule and current human approval.' })
  @BodySchema(scheduleRevisionInput)
  @JsonResponse(202, apiPostResource)
  async schedule(@Req() req: KeyRequest, @Param('id') id: string, @Body() body: unknown) {
    const data = validated(scheduleRevisionInput, body);
    const { actorId, workspaceId, slug } = req.principal;
    const postId = validated(z.uuid(), id);
    await scopedPost(workspaceId, postId);
    const requestedAt = data.mode === 'next' ? 'next' : data.mode === 'now' ? new Date() : new Date(data.scheduledAt);
    if (data.mode === 'at' && requestedAt instanceof Date && requestedAt.getTime() <= Date.now()) {
      throw new BadRequestException('Choose a future UTC time.');
    }
    await applyCommand(() => schedulePost(actorId, slug, postId, data.revision, data.channelIds, requestedAt));
    return scopedPost(workspaceId, postId);
  }

  @Post('posts/:id/cancel')
  @HttpCode(200)
  @RequireApiScope('posts:schedule')
  @ApiOperation({ summary: 'Cancel pending destinations', description: 'Requires posts:schedule.' })
  @JsonResponse(200, apiPostResource)
  async cancel(@Req() req: KeyRequest, @Param('id') id: string) {
    const { actorId, workspaceId, slug } = req.principal;
    const postId = validated(z.uuid(), id);
    await scopedPost(workspaceId, postId);
    await applyCommand(() => cancelPost(actorId, slug, postId));
    return scopedPost(workspaceId, postId);
  }
}
