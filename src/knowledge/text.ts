import { IDENTITY_DETAIL, IdentityError } from '../identity/errors.js';

function invalid(): IdentityError {
  return new IdentityError(422, 'Unprocessable Entity', IDENTITY_DETAIL.validation);
}

export function untrustedText(value: string, minimum: number, maximum: number): string {
  const text = value.replaceAll('\u0000', '').trim();
  if (text.length < minimum || text.length > maximum || hasControl(text) || hasActiveHtml(text)) {
    throw invalid();
  }
  return text;
}

export function searchTerm(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const term = value.replace(/[%_\\]/g, '').trim();
  if (term.length === 0) {
    return null;
  }
  if (term.length > 200) {
    throw invalid();
  }
  return term;
}

function hasControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) {
      return true;
    }
  }
  return false;
}

function hasActiveHtml(value: string): boolean {
  const lowered = value.toLowerCase();
  return lowered.includes('<script')
    || lowered.includes('</script')
    || lowered.includes('<iframe')
    || lowered.includes('javascript:')
    || lowered.includes('onerror=')
    || lowered.includes('onload=');
}
