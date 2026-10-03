import { cognitoIdpEndpoint, type RuntimeConfig } from '../../config/runtimeConfig';
import { createCognitoCall } from './api';
import { CognitoAuth } from './flows';

/** Own-login client for this installation's user pool and app client (runtime config). */
export function createCognitoAuth(config: RuntimeConfig): CognitoAuth {
  return new CognitoAuth({
    call: createCognitoCall(cognitoIdpEndpoint(config)),
    clientId: config.clientId,
    userPoolId: config.userPoolId,
  });
}
