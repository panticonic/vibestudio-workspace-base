/**
 * "See it live" — open the real panel a scene is talking about.
 *
 * Opening another panel is a gated host effect (`workspace.runtime-state.manage`),
 * so the first click from a fresh session raises the real approval card. That
 * is deliberate: the deck's authority story demonstrates itself.
 */
import { useCallback, useState } from "react";
import { openPanel } from "@workspace/runtime";

type LiveState = "idle" | "opening" | "opened" | "failed";

export interface LiveLinkProps {
  source: string;
  label: string;
  /** Short explanation shown next to the action. */
  hint?: string;
}

export function LiveLink({ source, label, hint }: LiveLinkProps) {
  const [state, setState] = useState<LiveState>("idle");
  const [detail, setDetail] = useState<string | null>(null);

  const open = useCallback(async () => {
    setState("opening");
    setDetail(null);
    try {
      await openPanel(source, { focus: true });
      setState("opened");
    } catch (error) {
      setState("failed");
      setDetail(error instanceof Error ? error.message : String(error));
    }
  }, [source]);

  return (
    <div className="live" role="group" aria-label={`See it live: ${label}`}>
      <button type="button" className="btn btn--ghost live__btn" onClick={open} disabled={state === "opening"}>
        <span aria-hidden="true">↗</span> {label}
      </button>
      <span className="live__hint" aria-live="polite">
        {state === "idle" ? hint : null}
        {state === "opening" ? "Opening. The first time, the host asks you to approve it." : null}
        {state === "opened" ? `Opened ${source}.` : null}
        {state === "failed" ? `Couldn't open ${source}: ${detail}` : null}
      </span>
    </div>
  );
}
