import type { MineStore, ReviewCandidate } from './store';

export interface ReviewSummary {
  totalScanned: number;
  proceduralCount: number;
  samples: ReviewCandidate[];
}

/**
 * Step 1.5 — produce a review summary. Stage-only: prints totals, a sample of
 * staged candidates and (via the CLI) extraction failures. Never promotes.
 */
export function buildReviewSummary(store: MineStore, sampleSize = 20): ReviewSummary {
  return {
    totalScanned: store.countRaw(),
    proceduralCount: store.countReview(),
    samples: store.listReview().slice(0, sampleSize),
  };
}
