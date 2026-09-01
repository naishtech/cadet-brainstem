/**
 * Shared adapter contract for external optimisation tools (RTK, Serena, LeanCTX).
 *
 * Cadet Brainstem does NOT reimplement these tools — it orchestrates them
 * behind a common interface so they can be swapped later (design doc §2).
 */
export interface ContextOptimizer {
  /** Stable identifier for the optimizing tool. */
  name: string;

  /** Whether the tool is installed/available in the current environment. */
  isAvailable(): Promise<boolean>;

  /** Optionally install the tool. */
  install?(): Promise<void>;

  /** Optionally configure the tool. */
  configure?(): Promise<void>;
}
