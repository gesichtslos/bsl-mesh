import { IDENTITY_DETAIL, IdentityError } from './errors.js';

const EMAIL = /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const DISPLAY_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._'()-]{0,79}$/u;

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) {
      return true;
    }
  }
  return false;
}

function invalid(): IdentityError {
  return new IdentityError(422, 'Unprocessable Entity', IDENTITY_DETAIL.validation);
}

export function parseEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !EMAIL.test(email)) {
    throw invalid();
  }
  return email;
}

export function parseDisplayName(value: string): string {
  const name = value.trim();
  if (name.length > 80 || hasControlCharacter(name) || !DISPLAY_NAME.test(name)) {
    throw invalid();
  }
  return name;
}

export function parseDescription(value: string | undefined): string {
  if (value === undefined) {
    return '';
  }
  const description = value.trim();
  if (description.length > 500 || hasControlCharacter(description)) {
    throw invalid();
  }
  return description;
}

export function parseTtlSeconds(value: number): number {
  return parseBoundedInteger(value, 60, 7_776_000);
}

export function parseInvitationTtlSeconds(value: number): number {
  return parseBoundedInteger(value, 60, 900);
}

export function parseInvitationCredentialTtlSeconds(value: number): number {
  return parseBoundedInteger(value, 60, 86_400);
}

function parseBoundedInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw invalid();
  }
  return value;
}
