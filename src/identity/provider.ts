import type { AppConfig } from '../config.js';
import { IdentityError, IDENTITY_DETAIL } from './errors.js';

export const OIDC_ADAPTER_STATUS = 'not_implemented' as const;

export type OidcAuthorizationCodeAdapter = {
  readonly issuer: string;
  readonly clientId: string;
  authorizationUrl(input: { state: string; nonce: string; redirectUri: string }): URL;
  exchangeCode(input: { code: string; redirectUri: string }): Promise<{ subject: string; email: string }>;
};

export type OneTimeCodeDelivery = {
  readonly mode: 'test' | 'disabled';
  deliver(message: { email: string; code: string; expiresAt: Date }): Promise<void>;
};

export type MagicLinkRoute = 'test' | 'disabled' | 'hidden';

export function magicLinkRoute(config: AppConfig): MagicLinkRoute {
  if (config.nodeEnv === 'production') {
    return 'hidden';
  }
  if (config.authTestAdapter) {
    return 'test';
  }
  return 'disabled';
}

export function createOneTimeCodeDelivery(config: AppConfig): OneTimeCodeDelivery {
  if (magicLinkRoute(config) !== 'test') {
    return {
      mode: 'disabled',
      deliver() {
        return Promise.reject(new IdentityError(403, 'Forbidden', IDENTITY_DETAIL.registrationDisabled));
      },
    };
  }
  return {
    mode: 'test',
    deliver() {
      return Promise.resolve();
    },
  };
}

export function describeIdentity(config: AppConfig): {
  publicRegistration: 'disabled';
  magicLink: MagicLinkRoute;
  oidc: 'not_configured' | 'not_implemented';
} {
  return {
    publicRegistration: 'disabled',
    magicLink: magicLinkRoute(config),
    oidc: config.oidc === null ? 'not_configured' : OIDC_ADAPTER_STATUS,
  };
}
