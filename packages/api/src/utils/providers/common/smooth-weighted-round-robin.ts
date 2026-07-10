export class SmoothWeightedRoundRobin {
  private readonly weights = new Map<number, number>();
  private readonly currentScores = new Map<number, number>();

  setToken(tokenId: number, weight: number): void {
    if (!Number.isInteger(weight) || weight < 1 || weight > 100) {
      throw new RangeError("weight must be an integer between 1 and 100");
    }
    if (this.weights.get(tokenId) === weight) return;
    this.weights.set(tokenId, weight);
    this.resetScores();
  }

  removeToken(tokenId: number): void {
    if (!this.weights.delete(tokenId)) return;
    this.currentScores.delete(tokenId);
    this.resetScores();
  }

  resetScores(): void {
    this.currentScores.clear();
  }

  select(eligibleTokenIds: ReadonlySet<number>): number | null {
    const candidates = [...eligibleTokenIds]
      .filter((tokenId) => this.weights.has(tokenId))
      .toSorted((a, b) => a - b);
    if (candidates.length === 0) return null;

    let selected = candidates[0]!;
    let selectedScore = Number.NEGATIVE_INFINITY;
    let totalWeight = 0;

    for (const tokenId of candidates) {
      const weight = this.weights.get(tokenId)!;
      totalWeight += weight;
      const score = (this.currentScores.get(tokenId) ?? 0) + weight;
      this.currentScores.set(tokenId, score);
      if (score > selectedScore) {
        selected = tokenId;
        selectedScore = score;
      }
    }

    this.currentScores.set(selected, selectedScore - totalWeight);
    return selected;
  }
}
