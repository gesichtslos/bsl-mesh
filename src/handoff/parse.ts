import { IDENTITY_DETAIL, IdentityError } from '../identity/errors.js';

export const HANDOFF_EXTENSION = 'https://bslmesh.ru/a2a/extensions/handoff/v1';

export const TASK_STATES = [
  'TASK_STATE_SUBMITTED',
  'TASK_STATE_WORKING',
  'TASK_STATE_INPUT_REQUIRED',
  'TASK_STATE_AUTH_REQUIRED',
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_REJECTED',
] as const;

export const ESCALATION_REASONS = [
  'missing_authority',
  'incompatible_context',
  'private_data',
  'ambiguous_request',
  'policy_rejection',
  'recipient_unavailable',
] as const;

export type TaskState = (typeof TASK_STATES)[number];
export type EscalationReason = (typeof ESCALATION_REASONS)[number];
export type Part = { text: string } | { data: unknown };

export type HandoffMessage = {
  messageId: string;
  role: 'ROLE_USER' | 'ROLE_AGENT';
  parts: Part[];
  taskId?: string;
  contextId?: string;
};

export type HandoffDirective = {
  recipientAgentId?: string;
  state?: TaskState;
  humanParticipated?: boolean;
  escalationReason?: EscalationReason;
};

export type SendDraft = {
  message: HandoffMessage;
  directive: HandoffDirective;
};

const KEY = /^[A-Za-z0-9_-]{8,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SKILL_ID = /^[a-z0-9-]{1,40}$/;

export type Skill = {
  id: string;
  name: string;
  description: string;
  tags: string[];
};

export function parseProfile(value: unknown): { availability: 'accepting' | 'paused'; skills: Skill[] } {
  const record = object(value);
  const availability = record['availability'];
  if (availability !== 'accepting' && availability !== 'paused') {
    throw invalid();
  }
  const skills = record['skills'];
  if (!Array.isArray(skills) || skills.length > 8) {
    throw invalid();
  }
  exactKeys(record, ['availability', 'skills']);
  return {
    availability,
    skills: skills.map((item) => parseSkill(item)),
  };
}

export function parseSender(value: unknown): string {
  const record = object(value);
  exactKeys(record, ['sender_agent_id']);
  return uuid(record['sender_agent_id']);
}

export function parseSend(value: unknown): SendDraft {
  const record = object(value);
  exactKeys(record, ['message', 'configuration', 'metadata']);
  const configuration = object(record['configuration']);
  if (configuration['taskPushNotificationConfig'] !== undefined) {
    throw new IdentityError(400, 'Bad Request', 'PushNotificationNotSupportedError');
  }
  exactKeys(configuration, ['returnImmediately']);
  if (configuration['returnImmediately'] !== true) {
    throw new IdentityError(400, 'Bad Request', 'UnsupportedOperationError');
  }
  const message = object(record['message']);
  exactKeys(message, ['messageId', 'role', 'parts', 'taskId', 'contextId']);
  const role = message['role'];
  if (role !== 'ROLE_USER' && role !== 'ROLE_AGENT') {
    throw invalid();
  }
  const draft: HandoffMessage = {
    messageId: key(message['messageId']),
    role,
    parts: parseParts(message['parts']),
  };
  if (message['taskId'] !== undefined) {
    draft.taskId = uuid(message['taskId']);
  }
  if (message['contextId'] !== undefined) {
    draft.contextId = uuid(message['contextId']);
  }
  return { message: draft, directive: parseDirective(record['metadata']) };
}

export function parseHistoryLength(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,2})$/.test(value)) {
    throw invalid();
  }
  const parsed = Number(value);
  if (parsed > 100) {
    throw invalid();
  }
  return parsed;
}

export function parsePageSize(value: unknown): number {
  if (value === undefined) {
    return 20;
  }
  if (typeof value !== 'string' || !/^[1-9][0-9]?$/.test(value)) {
    throw invalid();
  }
  const parsed = Number(value);
  if (parsed > 50) {
    throw invalid();
  }
  return parsed;
}

function parseDirective(value: unknown): HandoffDirective {
  if (value === undefined) {
    return {};
  }
  const record = object(value);
  exactKeys(record, [HANDOFF_EXTENSION]);
  const extension = record[HANDOFF_EXTENSION];
  if (extension === undefined) {
    return {};
  }
  const body = object(extension);
  exactKeys(body, ['recipientAgentId', 'state', 'humanParticipated', 'escalationReason']);
  const directive: HandoffDirective = {};
  if (body['recipientAgentId'] !== undefined) {
    directive.recipientAgentId = uuid(body['recipientAgentId']);
  }
  if (body['state'] !== undefined) {
    if (!(TASK_STATES as readonly string[]).includes(String(body['state']))) {
      throw invalid();
    }
    directive.state = body['state'] as TaskState;
  }
  if (body['humanParticipated'] !== undefined) {
    if (typeof body['humanParticipated'] !== 'boolean') {
      throw invalid();
    }
    directive.humanParticipated = body['humanParticipated'];
  }
  if (body['escalationReason'] !== undefined) {
    if (!(ESCALATION_REASONS as readonly string[]).includes(String(body['escalationReason']))) {
      throw invalid();
    }
    directive.escalationReason = body['escalationReason'] as EscalationReason;
  }
  return directive;
}

function parseSkill(value: unknown): Skill {
  const record = object(value);
  exactKeys(record, ['id', 'name', 'description', 'tags']);
  const id = record['id'];
  const name = record['name'];
  const description = record['description'];
  const tags = record['tags'];
  if (typeof id !== 'string' || !SKILL_ID.test(id)) {
    throw invalid();
  }
  if (typeof name !== 'string' || name.trim().length < 1 || name.length > 80) {
    throw invalid();
  }
  if (typeof description !== 'string' || description.trim().length < 1 || description.length > 400) {
    throw invalid();
  }
  if (!Array.isArray(tags) || tags.length > 8 || tags.some((tag) => typeof tag !== 'string' || tag.length < 1 || tag.length > 24)) {
    throw invalid();
  }
  return { id, name, description, tags: [...tags] };
}

function parseParts(value: unknown): Part[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) {
    throw invalid();
  }
  return value.map((item) => {
    const part = object(item);
    const keys = Object.keys(part);
    if (keys.includes('raw') || keys.includes('url')) {
      throw new IdentityError(400, 'Bad Request', 'ContentTypeNotSupportedError');
    }
    exactKeys(part, ['text', 'data']);
    const hasText = part['text'] !== undefined;
    const hasData = part['data'] !== undefined;
    if (hasText === hasData) {
      throw invalid();
    }
    if (hasText) {
      if (typeof part['text'] !== 'string' || part['text'].length < 1 || part['text'].length > 8000) {
        throw invalid();
      }
      return { text: part['text'] };
    }
    const encoded = JSON.stringify(part['data']);
    if (encoded === undefined || encoded.length > 4000) {
      throw invalid();
    }
    return { data: part['data'] as unknown };
  });
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid();
  }
  return value as Record<string, unknown>;
}

function exactKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(record).some((key) => !allowed.includes(key))) {
    throw invalid();
  }
}

function key(value: unknown): string {
  if (typeof value !== 'string' || !KEY.test(value)) {
    throw invalid();
  }
  return value;
}

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw invalid();
  }
  return value;
}

function invalid(): IdentityError {
  return new IdentityError(422, 'Unprocessable Entity', IDENTITY_DETAIL.validation);
}
