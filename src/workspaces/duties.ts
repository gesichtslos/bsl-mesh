export function workspaceDuties(workspaceId: string): {
  poll: {
    method: 'GET';
    path: '/api/v1/handoff/tasks';
    query: {
      contextId: string;
      role: 'recipient';
      state: 'TASK_STATE_SUBMITTED';
    };
    repeat: true;
  };
  server_push: false;
  claim: {
    from: 'TASK_STATE_SUBMITTED';
    to: 'TASK_STATE_WORKING';
    once: true;
    conflict_status: 409;
  };
  completion: {
    requires_artifact: true;
    poll_is_completion: false;
    health_is_completion: false;
    credential_is_completion: false;
  };
} {
  return {
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
  };
}
