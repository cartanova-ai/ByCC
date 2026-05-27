import {
  type AnthropicCredentials,
  type OpenAICredentials,
  type TokenCredentials,
} from "../../../application/token/token.types";

export function getAccessToken(creds: TokenCredentials): string {
  return creds.accessToken;
}

export function getRefreshToken(creds: TokenCredentials): string | undefined {
  return creds.refreshToken;
}

export function getExpiresAt(creds: TokenCredentials): number {
  if ("expiresAt" in creds) return creds.expiresAt;
  return creds.accessTokenExpiresAt;
}

export function isAnthropicCredentials(creds: TokenCredentials): creds is AnthropicCredentials {
  return "accountUuid" in creds;
}

export function isOpenAICredentials(creds: TokenCredentials): creds is OpenAICredentials {
  return "accountId" in creds;
}
