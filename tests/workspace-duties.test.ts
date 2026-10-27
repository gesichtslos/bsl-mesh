import { expect, test } from 'vitest';

import { workspaceDuties } from '../src/workspaces/duties.js';

test('active workspace duties require a repeated poll and refuse to treat it as completion', () => {
  const workspaceId = '018f1000-0000-7000-8000-0000000000aa';
  expect(workspaceDuties(workspaceId)).toEqual({
    poll: {
      method: 'GET',
      path: '/api/v1/handoff/tasks',
      query: {
        contextId: workspaceId,
        role: 'recipient',
        state: 'TASK_STATE_SUBMITTED',
      },
      repeat: true,
    },
    server_push: false,
    claim: {
      from: 'TASK_STATE_SUBMITTED',
      to: 'TASK_STATE_WORKING',
      once: true,
      conflict_status: 409,
    },
    completion: {
      requires_artifact: true,
      poll_is_completion: false,
      health_is_completion: false,
      credential_is_completion: false,
    },
  });
});
