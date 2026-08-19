export type ChatTokenOption = {
  name: string;
  provider: string;
  active: boolean;
  ord: number;
};

export type ChatConfig = {
  model: string;
  system: string;
  tokenName: string;
};

export function chatTokenOptions(
  tokens: ChatTokenOption[],
  provider: string | undefined,
): ChatTokenOption[] {
  return tokens
    .filter((token) => token.active && token.provider === provider)
    .toSorted((a, b) => a.ord - b.ord || a.name.localeCompare(b.name));
}

export function providerTokenMissing(
  tokens: ChatTokenOption[],
  provider: string | undefined,
): boolean {
  return (
    provider !== undefined && !tokens.some((token) => token.active && token.provider === provider)
  );
}

export function resolvedTokenName(
  tokenName: string,
  options: ChatTokenOption[],
  tokenListLoaded: boolean,
): string {
  if (!tokenName || !tokenListLoaded) return tokenName;
  return options.some((token) => token.name === tokenName) ? tokenName : "";
}

export function chatConfigChanged(previous: ChatConfig, current: ChatConfig): boolean {
  return (
    previous.model !== current.model ||
    previous.system !== current.system ||
    previous.tokenName !== current.tokenName
  );
}

export function tokenTargetPayload(tokenName: string): { tokenName?: string } {
  return tokenName ? { tokenName } : {};
}
