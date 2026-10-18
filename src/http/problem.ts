export type Problem = {
  type: 'about:blank';
  title: string;
  status: number;
  detail: string;
  request_id: string;
};

export function problem(status: number, title: string, detail: string, requestId: string): Problem {
  return {
    type: 'about:blank',
    title,
    status,
    detail,
    request_id: requestId,
  };
}

export const problemSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'title', 'status', 'detail', 'request_id'],
  properties: {
    type: { type: 'string', const: 'about:blank' },
    title: { type: 'string' },
    status: { type: 'integer' },
    detail: { type: 'string' },
    request_id: { type: 'string' },
  },
} as const;
