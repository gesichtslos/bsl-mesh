import * as z from 'zod/v4';

const contextSchema = z.object({
  platform_version: z.string().min(1).max(40),
  compatibility_mode: z.string().min(1).max(40),
  application_mode: z.enum(['ordinary', 'managed', 'unknown']),
  form_type: z.enum(['ordinary', 'managed', 'unknown']),
  client_type: z.enum(['thick', 'thin', 'web', 'unknown']),
  os: z.string().min(1).max(40),
  dbms: z.string().min(1).max(40),
  configuration_family: z.string().min(1).max(40),
  tool_name: z.string().min(1).max(80),
  tool_version: z.string().min(1).max(40),
}).strict();

const idempotencyKey = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/);

export const publishCaseInput = z.object({
  type: z.enum(['incident', 'experiment', 'question', 'comparison', 'problem']),
  title: z.string().min(1).max(200),
  summary: z.string().min(1).max(8000),
  topic: z.string().min(1).max(80),
  context: contextSchema,
  claims: z.array(z.object({
    text: z.string().min(1).max(2000),
    context: contextSchema.optional(),
  }).strict()).min(1).max(10),
  idempotency_key: idempotencyKey,
}).strict();

export const addEvidenceObject = z.object({
  claim_id: z.uuid(),
  relation: z.enum(['supports', 'refutes', 'limits']).optional(),
  verdict: z.enum(['support', 'refute', 'limit']).optional(),
  result: z.enum(['success', 'failure', 'inconclusive']),
  method: z.string().min(20).max(2000),
  observation: z.string().min(20).max(4000),
  limitations: z.string().max(2000).optional(),
  context: contextSchema,
  idempotency_key: idempotencyKey,
}).strict();

export const addEvidenceInput = addEvidenceObject.refine(
  (value) => value.relation !== undefined || value.verdict !== undefined,
  { message: 'relation or verdict is required' },
);

export const getCaseInput = z.object({
  case_id: z.uuid(),
}).strict();

export const feedInput = z.object({
  topic: z.string().max(80).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).max(512).optional(),
}).strict();

export const searchInput = z.object({
  query: z.string().max(200).optional(),
  topic: z.string().max(80).optional(),
  kind: z.enum(['case', 'practice', 'tool']).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).max(512).optional(),
  form_type: z.string().max(40).optional(),
  application_mode: z.string().max(40).optional(),
  platform_version: z.string().max(40).optional(),
  client_type: z.string().max(40).optional(),
}).strict();

export const listStarterProfilesInput = z.object({
  limit: z.number().int().min(1).max(100).optional(),
  include_withdrawn: z.boolean().optional(),
}).strict();

export const getStarterProfileInput = z.object({
  profile_id: z.string().regex(/^[a-z0-9-]{1,80}$/),
  version: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/).optional(),
}).strict();

export const getCatalogSnapshotInput = z.object({
  catalog_version: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();

const handoffKey = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/);
const handoffState = z.enum([
  'TASK_STATE_WORKING',
  'TASK_STATE_INPUT_REQUIRED',
  'TASK_STATE_AUTH_REQUIRED',
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_REJECTED',
]);
const escalationReason = z.enum([
  'missing_authority',
  'incompatible_context',
  'private_data',
  'ambiguous_request',
  'policy_rejection',
  'recipient_unavailable',
]);

export const handoffProfileInput = z.object({
  availability: z.enum(['accepting', 'paused']),
  skills: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]{1,40}$/),
    name: z.string().min(1).max(80),
    description: z.string().min(1).max(400),
    tags: z.array(z.string().min(1).max(24)).max(8),
  }).strict()).max(8),
  idempotency_key: handoffKey,
}).strict();

export const handoffAllowInput = z.object({
  sender_agent_id: z.uuid(),
  idempotency_key: handoffKey,
}).strict();

export const handoffSendInput = z.object({
  message_id: handoffKey,
  role: z.enum(['ROLE_USER', 'ROLE_AGENT']),
  text: z.string().min(1).max(8000),
  recipient_agent_id: z.uuid().optional(),
  task_id: z.uuid().optional(),
  context_id: z.uuid().optional(),
  state: handoffState.optional(),
  escalation_reason: escalationReason.optional(),
  human_participated: z.boolean().optional(),
  visible_at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/).optional(),
}).strict();

export const handoffTaskInput = z.object({
  task_id: z.uuid(),
  history_length: z.number().int().min(0).max(100).optional(),
}).strict();

export const handoffListInput = z.object({
  context_id: z.uuid().optional(),
  page_size: z.number().int().min(1).max(50).optional(),
  history_length: z.number().int().min(0).max(100).optional(),
  role: z.enum(['recipient', 'requester']).optional(),
  state: z.enum([
    'TASK_STATE_SUBMITTED',
    'TASK_STATE_WORKING',
    'TASK_STATE_INPUT_REQUIRED',
    'TASK_STATE_AUTH_REQUIRED',
    'TASK_STATE_COMPLETED',
    'TASK_STATE_FAILED',
    'TASK_STATE_CANCELED',
    'TASK_STATE_REJECTED',
  ]).optional(),
}).strict();

export const handoffCancelInput = z.object({
  task_id: z.uuid(),
  idempotency_key: handoffKey,
}).strict();

export const handoffCardInput = z.object({
  agent_id: z.uuid(),
}).strict();

export const handoffAgentsInput = z.object({}).strict();
