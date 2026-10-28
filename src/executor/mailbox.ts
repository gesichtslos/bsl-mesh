export class MailboxError extends Error {
  constructor(
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super('The mailbox request failed.');
    this.name = 'MailboxError';
  }
}

export type WaitingTask = {
  id: string;
};

export type TaskBody = {
  text: string;
  state: string;
  claimToken: string | null;
};

export type TaskOutcome = {
  state: string;
  timestamp: string;
  artifact: string;
};

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const EXTENSION = 'https://bslmesh.ru/a2a/extensions/handoff/v1';

export type MailboxClient = {
  listSubmitted(contextId: string | undefined): Promise<WaitingTask[]>;
  listRequester(contextId: string | undefined, state: string): Promise<WaitingTask[]>;
  read(taskId: string): Promise<TaskBody>;
  readOutcome(taskId: string): Promise<TaskOutcome>;
  claim(taskId: string, claimToken: string): Promise<void>;
  publish(taskId: string, text: string): Promise<void>;
  sendPrepared(idempotencyKey: string, body: Record<string, unknown>): Promise<string>;
};

export class Mailbox implements MailboxClient {
  constructor(
    private readonly baseUrl: string,
    private readonly credential: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async listSubmitted(contextId: string | undefined): Promise<WaitingTask[]> {
    const query = new URLSearchParams({
      role: 'recipient',
      state: 'TASK_STATE_SUBMITTED',
      historyLength: '0',
      pageSize: '20',
    });
    if (contextId !== undefined) {
      query.set('contextId', contextId);
    }
    const body = await this.request<{ tasks?: Array<{ id?: string; status?: { state?: string } }> }>(
      `/api/v1/handoff/tasks?${query.toString()}`,
      { method: 'GET' },
    );
    return (body.tasks ?? []).flatMap((task) => (
      typeof task.id === 'string' && task.status?.state === 'TASK_STATE_SUBMITTED'
        ? [{ id: task.id }]
        : []
    ));
  }

  async listRequester(contextId: string | undefined, state: string): Promise<WaitingTask[]> {
    const query = new URLSearchParams({
      role: 'requester',
      state,
      historyLength: '0',
      pageSize: '20',
    });
    if (contextId !== undefined) {
      query.set('contextId', contextId);
    }
    const body = await this.request<{ tasks?: Array<{ id?: string; status?: { state?: string } }>; nextPageToken?: unknown }>(
      `/api/v1/handoff/tasks?${query.toString()}`,
      { method: 'GET' },
    );
    return (body.tasks ?? []).flatMap((task) => (
      typeof task.id === 'string' && task.status?.state === state
        ? [{ id: task.id }]
        : []
    ));
  }

  async read(taskId: string): Promise<TaskBody> {
    const body = await this.request<{
      status?: { state?: string };
      history?: Array<{ role?: string; parts?: Array<{ text?: string }> }>;
      metadata?: Record<string, { claimToken?: string }>;
    }>(`/api/v1/handoff/tasks/${taskId}?historyLength=20`, { method: 'GET' });
    const opening = (body.history ?? []).find((item) => item.role === 'ROLE_USER');
    const text = opening?.parts?.map((part) => part.text ?? '').join('\n') ?? '';
    const claimToken = body.metadata?.[EXTENSION]?.claimToken;
    return {
      text,
      state: body.status?.state ?? '',
      claimToken: typeof claimToken === 'string' ? claimToken : null,
    };
  }

  async readOutcome(taskId: string): Promise<TaskOutcome> {
    const body = await this.request<{
      status?: { state?: string; timestamp?: string };
      artifacts?: Array<{ parts?: Array<{ text?: string }> }>;
    }>(`/api/v1/handoff/tasks/${taskId}?historyLength=0`, { method: 'GET' });
    const artifact = (body.artifacts ?? [])
      .flatMap((item) => item.parts ?? [])
      .map((part) => part.text ?? '')
      .filter((text) => text !== '')
      .join('\n');
    return {
      state: body.status?.state ?? '',
      timestamp: body.status?.timestamp ?? '',
      artifact,
    };
  }

  async claim(taskId: string, claimToken: string): Promise<void> {
    const messageId = `claim-${taskId.replaceAll('-', '')}`;
    await this.request('/api/v1/handoff/messages', {
      method: 'POST',
      idempotencyKey: messageId,
      body: {
        message: {
          messageId,
          taskId,
          role: 'ROLE_AGENT',
          parts: [{ text: 'Исполнитель принимает задачу.' }],
        },
        configuration: { returnImmediately: true },
        metadata: { [EXTENSION]: { state: 'TASK_STATE_WORKING', claimToken } },
      },
    });
  }

  async sendPrepared(idempotencyKey: string, body: Record<string, unknown>): Promise<string> {
    const response = await this.request<{ id?: string }>('/api/v1/handoff/messages', {
      method: 'POST',
      idempotencyKey,
      body,
    });
    if (typeof response.id !== 'string' || response.id === '') {
      throw new MailboxError(502, false);
    }
    return response.id;
  }

  async publish(taskId: string, text: string): Promise<void> {
    const messageId = `result-${taskId.replaceAll('-', '')}`;
    await this.request('/api/v1/handoff/messages', {
      method: 'POST',
      idempotencyKey: messageId,
      body: {
        message: {
          messageId,
          taskId,
          role: 'ROLE_AGENT',
          parts: [{ text }],
        },
        configuration: { returnImmediately: true },
        metadata: { [EXTENSION]: { state: 'TASK_STATE_COMPLETED', humanParticipated: false } },
      },
    });
  }

  private async request<T>(path: string, init: { method: string; idempotencyKey?: string; body?: unknown }): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: init.method,
        headers: {
          authorization: `Bearer ${this.credential}`,
          ...(init.body === undefined ? {} : { 'content-type': 'application/json', 'idempotency-key': init.idempotencyKey ?? '' }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
    } catch {
      throw new MailboxError(0, true);
    }
    const raw = await response.text();
    const parsed: unknown = raw === '' ? {} : JSON.parse(raw) as unknown;
    if (response.status === 401 || response.status === 403) {
      throw new MailboxError(response.status, false);
    }
    if (response.status === 409) {
      throw new MailboxError(409, false);
    }
    if (response.status >= 500 || response.status === 429) {
      throw new MailboxError(response.status, true);
    }
    if (response.status >= 400) {
      throw new MailboxError(response.status, false);
    }
    return parsed as T;
  }
}
