import { IdentityError } from '../identity/errors.js';

export function assertSafeHttpsUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw rejected();
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    throw rejected();
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    host === 'localhost'
    || host.endsWith('.localhost')
    || host === '127.0.0.1'
    || host === '::1'
    || host === '0.0.0.0'
    || host === 'metadata.google.internal'
    || host.startsWith('10.')
    || host.startsWith('192.168.')
    || host.startsWith('169.254.')
    || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
  ) {
    throw rejected();
  }
}

function rejected(): IdentityError {
  return new IdentityError(422, 'Unprocessable Entity', 'The upstream URL is not an allowed public https address.');
}
