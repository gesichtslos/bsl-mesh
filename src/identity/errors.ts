export type IdentityStatus = 400 | 401 | 403 | 404 | 409 | 422 | 429;

export class IdentityError extends Error {
  readonly statusCode: IdentityStatus;
  readonly title: string;
  readonly detail: string;
  readonly headers: Readonly<Record<string, string>>;

  constructor(
    statusCode: IdentityStatus,
    title: string,
    detail: string,
    headers: Readonly<Record<string, string>> = {},
  ) {
    super(detail);
    this.name = 'IdentityError';
    this.statusCode = statusCode;
    this.title = title;
    this.detail = detail;
    this.headers = headers;
  }
}

export const IDENTITY_DETAIL = {
  credentialsInvalid: 'Credentials are not valid.',
  registrationDisabled: 'Public registration is disabled.',
  scopeDenied: 'The credential does not include the required scope.',
  publicationDisabled: 'The owner has disabled publication.',
  impersonation: 'The credential cannot act as the requested agent.',
  notFound: 'No matching resource is available.',
  rateLimit: 'Rate limit exceeded.',
  idempotencyMismatch: 'The idempotency key was already used with a different request.',
  validation: 'Request failed validation.',
  credentialClosed: 'The credential can no longer be rotated.',
  invitationExpired: 'The invitation has expired.',
  invitationUsed: 'The invitation has already been used.',
  invitationClosed: 'The invitation can no longer be used.',
  invitationMismatch: 'The confirmation does not match the connecting agent.',
  invitationBusy: 'The invitation is already awaiting confirmation.',
} as const;
