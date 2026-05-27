/**
 * TokenPicker — 토큰 선택 알고리즘 인터페이스 + RoundRobinPicker 구현.
 */

export interface TokenPicker<T extends { id: number }> {
  pick(tokens: T[]): T | null;
}

export class RoundRobinPicker<T extends { id: number }> implements TokenPicker<T> {
  private cursor = 0;

  pick(tokens: T[]): T | null {
    if (tokens.length === 0) return null;
    const picked = tokens[this.cursor % tokens.length]!;
    this.cursor++;
    return picked;
  }
}
