import type { QuantName, ServerKind } from "@workspace/model-catalog/localModels";
import {
  LOCAL_DEFAULT_MODEL as CATALOG_DEFAULT_MODEL,
  LOCAL_FALLBACK_MODEL as CATALOG_FALLBACK_MODEL,
} from "@workspace/model-catalog/catalog";

/** Machine-global storage layout owned by the local-model implementation. */
export const ROOT_LAYOUT = {
  ownerLock: "owner.lock",
  ownerInfo: "owner.json",
  authKey: "auth.key",
  config: "config.json",
  serverLog: (kind: ServerKind) => `${kind}-server.log`,
  enginesDir: "engines",
  modelsDir: "models",
} as const;

export const FALLBACK_MODEL = {
  slug: CATALOG_FALLBACK_MODEL.id,
  ref: CATALOG_FALLBACK_MODEL.ref,
  displayName: CATALOG_FALLBACK_MODEL.name,
  hfRepo: "LiquidAI/LFM2.5-2.6B-GGUF",
  quant: "Q4_K_M" as QuantName,
  file: "LFM2.5-2.6B-Q4_K_M.gguf",
  sha256: "79fdf00351b46cf26f020aead28d01889886be87c55fa0eb907e6f9b00bfee14",
  downloadSizeBytes: CATALOG_FALLBACK_MODEL.downloadSizeBytes,
  contextLength: CATALOG_FALLBACK_MODEL.contextWindow,
} as const;

/** Preferred local agent model. It uses the ordinary main-router path; unlike
 * the compact fallback, it is offered only on hardware tiers that can fit it. */
export const DEFAULT_MODEL = {
  slug: CATALOG_DEFAULT_MODEL.id,
  ref: CATALOG_DEFAULT_MODEL.ref,
  displayName: CATALOG_DEFAULT_MODEL.name,
  hfRepo: "unsloth/Qwen3.8-27B-GGUF",
  quant: "UD-Q4_K_M" as QuantName,
  file: "Qwen3.8-27B-UD-Q4_K_M.gguf",
  sha256: "322e194ff79741c7baa497c240f677f54b201b0efab44ca8e50f122b39123482",
  downloadSizeBytes: CATALOG_DEFAULT_MODEL.downloadSizeBytes,
  contextLength: CATALOG_DEFAULT_MODEL.contextWindow,
  supportedTiers: ["gpu-large"] as const,
} as const;
