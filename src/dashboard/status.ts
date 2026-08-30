import { DEFAULT_OLLAMA_HOST, isModelAvailable } from '../classifier';
import { loadConfig } from '../config';
import { detectEnvironment } from '../core/environment';

export type ServiceKind = 'llm' | 'rtk' | 'serena' | 'leanctx';

/** Service status for the dashboard status icons (design doc §5.5). */
export interface ToolStatus {
  name: string;
  available: boolean;
  /** Version / reachability note when available, else an availability hint. */
  detail?: string;
  kind: ServiceKind;
}

export interface GetServiceStatusOptions {
  /** Classifier model to verify via isModelAvailable (defaults to config). */
  model?: string;
  /** Ollama host override. */
  host?: string;
  /** Test seam. */
  detect?: typeof detectEnvironment;
  /** Test seam. */
  modelAvailable?: typeof isModelAvailable;
  /** Test seam. Defaults to loadConfig(). */
  getConfig?: () => { classifier: { model: string } };
}

/**
 * Resolve live status for the four dashboard services (design doc §5.5):
 * the local LLM (Ollama + classifier model), RTK, Serena, and LeanCTX.
 *
 * The LLM is "available" only when Ollama is reachable AND the configured
 * classifier model is present. Detection never throws — missing tools degrade
 * to `available: false` with a hint.
 */
export async function getServiceStatus(
  options: GetServiceStatusOptions = {},
): Promise<ToolStatus[]> {
  const detect = options.detect ?? detectEnvironment;
  const modelAvailable = options.modelAvailable ?? isModelAvailable;
  const getConfig =
    options.getConfig ?? (() => loadConfig() as { classifier: { model: string } });
  const host = options.host ?? process.env.OLLAMA_HOST ?? DEFAULT_OLLAMA_HOST;

  let model = options.model;
  if (model === undefined) {
    try {
      model = getConfig().classifier.model;
    } catch {
      model = '';
    }
  }

  const env = await detect(host);

  let llmAvailable = env.ollama.available;
  let llmDetail: string | undefined = env.ollama.detail;
  if (llmAvailable && model !== undefined && model.length > 0) {
    const present = await modelAvailable(model, host);
    if (!present) {
      llmAvailable = false;
      llmDetail = `Ollama reachable but classifier model "${model}" not present`;
    } else {
      // Show the running model so the UI can render e.g. "LLM [qwen3:4b]".
      llmDetail = model;
    }
  }

  return [
    {
      name: 'ollama',
      kind: 'llm',
      available: llmAvailable,
      ...(llmDetail !== undefined ? { detail: llmDetail } : {}),
    },
    {
      name: 'rtk',
      kind: 'rtk',
      available: env.rtk.available,
      ...(env.rtk.detail !== undefined ? { detail: env.rtk.detail } : {}),
    },
    {
      name: 'serena',
      kind: 'serena',
      available: env.serena.available,
      ...(env.serena.detail !== undefined ? { detail: env.serena.detail } : {}),
    },
    {
      name: 'leanctx',
      kind: 'leanctx',
      available: env.leanctx.available,
      ...(env.leanctx.detail !== undefined ? { detail: env.leanctx.detail } : {}),
    },
  ];
}
