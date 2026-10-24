export class MeshError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    readonly retryable: boolean,
  ) {
    super(detail);
    this.name = 'MeshError';
  }
}

export type ListedTask = {
  id: string;
  state: string;
};

export type TaskText = {
  id: string;
  state: string;
  text: string;
  claimToken: string | null;
};

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class MeshClient {
  constructor(
    private readonly baseUrl: string,
    private readonly credential: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async listWaiting(): Promise<ListedTask[]> {
    return this.listByState('TASK_STATE_SUBMITTED');
  }

  async listByState(state: string): Promise<ListedTask[]> {
    const body = await this.request<{ tasks?: Array<{ id?: string; status?: { state?: string } }> }>(
      `/api/v1/handoff/tasks?role=recipient&state=${state}&historyLength=0&pageSize=20`,
      { method: 'GET' },
    );
    return (body.tasks ?? []).flatMap((task) => (
      typeof task.id === 'string' && task.status?.state === 'TASK_STATE_SUBMITTED'
        ? [{ id: task.id, state: task.status.state }]
        : []
    ));
  }

  async readTask(taskId: string): Promise<TaskText> {
    const body = await this.request<{
      id?: string;
      status?: { state?: string };
      history?: Array<{ role?: string; parts?: Array<{ text?: string }> }>;
      metadata?: Record<string, { claimToken?: string }>;
    }>(`/api/v1/handoff/tasks/${taskId}?historyLength=20`, { method: 'GET' });
    const history = body.history ?? [];
    const opening = history.find((item) => item.role === 'ROLE_USER');
    const text = opening?.parts?.map((part) => part.text ?? '').join('\n') ?? '';
    const claimToken = body.metadata?.['https://bslmesh.ru/a2a/extensions/handoff/v1']?.claimToken;
    return {
      id: body.id ?? taskId,
      state: body.status?.state ?? '',
      text,
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
          parts: [{ text: 'Локальный адаптер принимает задачу для текстового ответа.' }],
        },
        configuration: { returnImmediately: true },
        metadata: {
          'https://bslmesh.ru/a2a/extensions/handoff/v1': {
            state: 'TASK_STATE_WORKING',
            claimToken,
          },
        },
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
        metadata: {
          'https://bslmesh.ru/a2a/extensions/handoff/v1': {
            state: 'TASK_STATE_COMPLETED',
            humanParticipated: false,
          },
        },
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
    } catch (error) {
      throw new MeshError(0, error instanceof Error ? error.name : 'network', true);
    }
    const raw = await response.text();
    const parsed: unknown = raw === '' ? {} : JSON.parse(raw) as unknown;
    if (response.status === 401 || response.status === 403) {
      throw new MeshError(response.status, 'The credential was rejected.', false);
    }
    if (response.status === 409) {
      throw new MeshError(409, 'The mailbox rejected a conflicting retry.', false);
    }
    if (response.status >= 500 || response.status === 429) {
      throw new MeshError(response.status, 'The mailbox is temporarily unavailable.', true);
    }
    if (response.status >= 400) {
      throw new MeshError(response.status, 'The mailbox rejected the request.', false);
    }
    return parsed as T;
  }
}
