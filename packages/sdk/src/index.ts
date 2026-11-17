import {
  apiChannelPage, apiKeyPattern, apiPostPage, apiPostResource, createDraftInput, pageInput,
  scheduleRevisionInput, submitRevisionInput, workspaceSlug,
} from '@cadencedesk/contracts';
import { z } from 'zod';

export type DraftInput = z.input<typeof createDraftInput>;
export type ReviewInput = z.input<typeof submitRevisionInput>;
export type ScheduleInput = z.input<typeof scheduleRevisionInput>;
export type PageInput = { limit?: number; offset?: number };

type ClientOptions = {
  apiUrl: string;
  workspace: string;
  apiKey: string;
  allowHttp?: boolean;
};

export class CadenceDeskApiError extends Error {
  constructor(message: string, readonly status?: number, readonly retryAfterSeconds?: number) {
    super(message);
    this.name = 'CadenceDeskApiError';
  }
}

function apiBaseUrl(value: string, allowHttp: boolean) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CadenceDeskApiError('Set a valid Superstar API URL.');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && (loopback || allowHttp)))) {
    throw new CadenceDeskApiError('Use an HTTPS API URL or explicitly enable HTTP for an internal deployment.');
  }
  url.pathname = url.pathname.replace(/\/+$/, '') + '/';
  return url;
}

const errorBody = z.object({ message: z.string() }).loose();

export class CadenceDeskClient {
  readonly workspace: string;
  readonly #apiBase: URL;
  readonly #apiKey: string;

  constructor(options: ClientOptions) {
    const workspace = workspaceSlug.safeParse(options.workspace);
    if (!workspace.success) throw new CadenceDeskApiError('Set a valid workspace slug.');
    if (!apiKeyPattern.test(options.apiKey)) throw new CadenceDeskApiError('Set a valid Superstar API key.');
    this.workspace = workspace.data;
    this.#apiBase = apiBaseUrl(options.apiUrl, options.allowHttp === true);
    this.#apiKey = options.apiKey;
  }

  private async request<T>(path: string, output: z.ZodType<T>, options?: { body: unknown; idempotencyKey?: string }) {
    const url = new URL(`v1/workspaces/${this.workspace}/${path}`, this.#apiBase);
    const headers: Record<string, string> = { Authorization: 'Bearer ' + this.#apiKey, Accept: 'application/json' };
    if (options) headers['Content-Type'] = 'application/json';
    if (options?.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;

    let response: Response;
    try {
      response = await fetch(url, {
        method: options ? 'POST' : 'GET',
        headers,
        body: options ? JSON.stringify(options.body) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new CadenceDeskApiError('The Superstar API request could not be completed.');
    }
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const parsed = errorBody.safeParse(data);
      const detail = parsed.success
        ? parsed.data.message.replaceAll(this.#apiKey, '[redacted]').replace(/[\r\n\t]+/g, ' ').slice(0, 300)
        : 'The request failed.';
      const retry = Number(response.headers.get('Retry-After'));
      throw new CadenceDeskApiError(
        `HTTP ${response.status} · ${detail}`, response.status,
        Number.isFinite(retry) && retry > 0 ? retry : undefined,
      );
    }
    const validated = output.safeParse(data);
    if (!validated.success) throw new CadenceDeskApiError('The Superstar API returned an unexpected response.');
    return validated.data;
  }

  private getPage<T>(path: string, output: z.ZodType<T>, query: PageInput) {
    const { limit, offset } = pageInput.parse(query);
    return this.request(`${path}?limit=${limit}&offset=${offset}`, output);
  }

  listChannels(query: PageInput = {}) {
    return this.getPage('channels', apiChannelPage, query);
  }

  listPosts(query: PageInput = {}) {
    return this.getPage('posts', apiPostPage, query);
  }

  getPost(id: string) {
    return this.request(`posts/${z.uuid().parse(id)}`, apiPostResource);
  }

  createDraft(input: DraftInput, options: { idempotencyKey?: string } = {}) {
    return this.request('posts', apiPostResource, {
      body: createDraftInput.parse(input),
      idempotencyKey: options.idempotencyKey === undefined ? undefined : z.uuid().parse(options.idempotencyKey),
    });
  }

  requestReview(id: string, input: ReviewInput) {
    return this.request(`posts/${z.uuid().parse(id)}/review`, apiPostResource, { body: submitRevisionInput.parse(input) });
  }

  schedulePost(id: string, input: ScheduleInput) {
    return this.request(`posts/${z.uuid().parse(id)}/schedule`, apiPostResource, { body: scheduleRevisionInput.parse(input) });
  }

  cancelPost(id: string) {
    return this.request(`posts/${z.uuid().parse(id)}/cancel`, apiPostResource, { body: {} });
  }
}

export function clientFromEnvironment(env: NodeJS.ProcessEnv = process.env) {
  return new CadenceDeskClient({
    apiUrl: env.CADENCEDESK_API_URL || 'http://localhost:3001',
    workspace: env.CADENCEDESK_WORKSPACE ?? '',
    apiKey: env.CADENCEDESK_API_KEY ?? '',
    allowHttp: env.CADENCEDESK_ALLOW_HTTP === 'true',
  });
}
