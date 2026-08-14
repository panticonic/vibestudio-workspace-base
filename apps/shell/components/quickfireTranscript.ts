/**
 * The transcript projection now lives in `@workspace/quickfire-core/transcript`
 * so the mobile quickfire sheet renders the identical tail (spec §7.2).
 *
 * This module stays as the shell's import site — and as the home of
 * `quickfireTranscript.test.ts`, which pins the shape, ordering, and truncation
 * rule the overlay's scroll behavior depends on.
 */

export {
  TRANSCRIPT_LIMIT,
  hasOpenTurn,
  projectTranscript,
} from "@workspace/quickfire-core/transcript";
