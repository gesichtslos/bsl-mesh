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

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const EXTENSION = 'https://bslmesh.ru/a2a/extensions/handoff/v1';

export type MailboxClient = {
  listSubmitted(contextId: string | undefined): Promise<WaitingTask[]>;
  read(taskId: string): Promise<TaskBody>;
  claim(taskId: string, claimToken: string): Promise<void>;
  publish(taskId: string, text: string): Promise<void>;
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
