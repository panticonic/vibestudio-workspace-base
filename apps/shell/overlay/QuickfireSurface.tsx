/**
 * The overlay surface: the palette card floating over the live panel, and the
 * Quickfire conversation it turns into (spec §4).
 *
 * Pure view — props in, intents out, no RPC (`QuickfireOwner` holds every piece
 * of state and performs every call). What *is* new here is where the drawing
 * happens: the conversation is `@workspace/quickfire-core/ui`'s component tree
 * rendered through this file's DOM skin, so the desktop overlay and the mobile
 * sheet are the same transcript with different primitives rather than two
 * transcripts that agree by hand until they stop agreeing.
 *
 * The one thing this surface owns locally is the text input's value. Round
 * tripping each keystroke to the chrome and back would make typing stutter, so
 * the input is uncontrolled and merely *echoes* changes upward; the chrome
 * overwrites it only when it deliberately wants to (mode chips, popping an
 * argument, restoring a query), which it signals by bumping `inputEpoch`.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  QUICKFIRE_MODE_CHIPS,
  isQuickfireSurfaceProps,
  type QuickfireIntent,
  type QuickfireRow,
  type QuickfireSurfaceProps,
} from "./quickfireSurfaceModel";
import {
  ConversationBody,
  ConversationHeader,
  QuickfireSkinProvider,
  type ConversationIntent,
} from "@workspace/quickfire-core/ui";
import { createDomSkin } from "./domSkin";
import { splitTextByMatchRanges } from "@vibestudio/shared/panelChrome";
import type { OverlaySurfaceComponentProps } from "./types";
import "./quickfire.css";

function fitInputToContent(input: HTMLTextAreaElement) {
  // Collapse first so deleting text can shrink the composer as well as typing
  // can grow it. CSS owns the maximum height and supplies scrolling beyond it.
  input.style.height = "0px";
  input.style.height = `${input.scrollHeight}px`;
}

export function QuickfireSurface({
  props,
  emitIntent,
}: OverlaySurfaceComponentProps) {
  const skin = useMemo(
    () =>
      createDomSkin({
        openLink: (href) =>
          (emitIntent as (intent: QuickfireIntent) => void)({
            type: "open-link",
            href,
          }),
      }),
    [emitIntent],
  );
  if (!isQuickfireSurfaceProps(props)) return null;
  return (
    <QuickfireSkinProvider value={skin}>
      <QuickfireCard
        {...props}
        emit={emitIntent as (intent: QuickfireIntent) => void}
      />
    </QuickfireSkinProvider>
  );
}

function QuickfireCard(
  props: QuickfireSurfaceProps & { emit: (intent: QuickfireIntent) => void },
) {
  const {
    mode,
    inputValue,
    inputEpoch,
    placeholder,
    ghostSuffix,
    groups,
    selectedId,
    argSession,
    context,
    emptyMessage,
    flashRowId,
    compose,
    emit,
  } = props;
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const adoptedEpochRef = useRef<number | null>(null);

  // Adopt a chrome-pushed value only when the epoch moves. Assigning on every
  // render is exactly the round-trip this surface exists to avoid: it would
  // clobber characters typed while the previous echo was still in flight.
  useLayoutEffect(() => {
    if (adoptedEpochRef.current === inputEpoch) return;
    adoptedEpochRef.current = inputEpoch;
    const input = inputRef.current;
    if (!input) return;
    input.value = inputValue;
    input.setSelectionRange(inputValue.length, inputValue.length);
    fitInputToContent(input);
  }, [inputEpoch, inputValue]);

  // The palette always takes focus on open (§2.3) — main focuses the view, and
  // this puts the caret in the input.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    const row = listRef.current?.querySelector(
      `[data-row-id="${CSS.escape(selectedId)}"]`,
    );
    if (row && "scrollIntoView" in row)
      row.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const input = event.currentTarget;
    const atEnd = input.selectionStart === input.value.length;
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp": {
        // Once a conversation composer contains text, vertical arrows belong
        // to the textarea. The browser understands both explicit newlines and
        // visual wrapping; intercepting the keys here made it impossible to
        // move the caret through a multi-line message. Empty compose retains
        // shell-style history recall, while palette input retains row walking.
        if (compose && input.value.length > 0) return;
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        // In a conversation there are no rows to walk, and the thing a person
        // reaches for ↑ to get is what they typed last — the shell habit.
        emit(compose ? { type: "recall", delta } : { type: "move", delta });
        return;
      }
      case "Tab":
        if (!ghostSuffix) return;
        event.preventDefault();
        emit({ type: "accept-completion" });
        return;
      case "ArrowRight":
        if (!ghostSuffix || !atEnd) return;
        event.preventDefault();
        emit({ type: "accept-completion" });
        return;
      case "Enter": {
        // Shift+Enter is a newline in compose and a no-op elsewhere (§1.3).
        if (event.shiftKey) {
          if (!compose) event.preventDefault();
          return;
        }
        const promoting = event.metaKey || event.ctrlKey;
        event.preventDefault();
        if (compose) {
          if (compose.disabledReason || compose.promoted) return;
          const text = input.value;
          if (!text.trim()) return;
          emit(
            promoting
              ? { type: "send-and-promote", text }
              : { type: "send", text },
          );
          input.value = "";
          fitInputToContent(input);
          return;
        }
        if (selectedId) emit({ type: "activate", rowId: selectedId });
        return;
      }
      case "Backspace":
        if (input.value.length > 0) return;
        event.preventDefault();
        emit({ type: "backspace-empty" });
        return;
      case "Escape":
        event.preventDefault();
        // The chrome runs the Esc chain (§1.3): collapse, then close.
        emit({ type: "escape" });
        return;
      case "k":
      case "K":
        if (!event.metaKey && !event.ctrlKey) return;
        event.preventDefault();
        if (!compose) emit({ type: "cycle-mode" });
        return;
      default:
    }
  };

  // Escape and list navigation must work wherever focus sits inside the card —
  // after clicking a row, Clear, or a mode chip the input no longer has it, and
  // hanging the whole key map off the input made the overlay feel stuck. The
  // input keeps its own handler for the text-editing keys (ghost completion,
  // backspace-on-empty, send); this document-level listener only covers the
  // keys that belong to the surface as a whole.
  useEffect(() => {
    const onDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.target === inputRef.current) return;
      switch (event.key) {
        case "Escape":
          event.preventDefault();
          emit({ type: "escape" });
          return;
        case "ArrowDown":
          event.preventDefault();
          emit({ type: "move", delta: 1 });
          return;
        case "ArrowUp":
          event.preventDefault();
          emit({ type: "move", delta: -1 });
          return;
        default:
      }
    };
    document.addEventListener("keydown", onDocumentKeyDown);
    return () => document.removeEventListener("keydown", onDocumentKeyDown);
  }, [emit]);

  // Newest-first means the newest entry is the top of the body, directly under
  // the input. Keep it in view when it changes — but only for a reader who is
  // already up there, because yanking someone out of an older answer they are
  // deliberately reading is worse than making them scroll back.
  const bodyRef = useRef<HTMLDivElement>(null);
  const newestId = compose?.transcript[0]?.id ?? null;
  const [missedNew, setMissedNew] = useState(false);
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || !newestId) return;
    if (body.scrollTop < 80) {
      body.scrollTop = 0;
      setMissedNew(false);
      return;
    }
    // Something arrived while they were reading something else. Not moving the
    // scroll was right; saying nothing about it was not.
    setMissedNew(true);
  }, [newestId]);

  const conversing = compose !== null;
  const replyingToConversation = compose?.kind === "conversation";
  return (
    <div
      className="quickfire-card"
      data-mode={conversing ? "conversation" : "palette"}
      role="dialog"
      aria-label={conversing ? "Quickfire agent" : "Command palette"}
    >
      {conversing ? (
        // The overlay floats over the panel it is about; being able to move it
        // off whatever you are trying to look at is the difference between a
        // window and a lid.
        <div className="quickfire-header" data-overlay-drag-handle="">
          <ConversationHeader
            compose={compose}
            onIntent={(intent) => emit(conversationIntent(intent))}
          />
        </div>
      ) : null}

      <div className="quickfire-entry">
        {argSession ? (
          <div className="quickfire-breadcrumb">
            <span className="quickfire-chip quickfire-chip-command">
              {argSession.commandTitle}
            </span>
            {argSession.chips.map((chip) => (
              <span key={chip.name} className="quickfire-chip">
                <span className="quickfire-chip-name">{chip.label}</span>
                {chip.value}
              </span>
            ))}
            <span className="quickfire-arg-label">
              {argSession.activeLabel}:
            </span>
          </div>
        ) : (
          <span className="quickfire-entry-icon" aria-hidden="true">
            {conversing ? "✦" : "⌕"}
          </span>
        )}
        <span className="quickfire-input-wrap">
          {ghostSuffix ? (
            <span className="quickfire-ghost" aria-hidden="true">
              <span className="quickfire-ghost-typed">{inputValue}</span>
              <span className="quickfire-ghost-suffix">{ghostSuffix}</span>
            </span>
          ) : null}
          <textarea
            ref={inputRef}
            className="quickfire-input"
            rows={1}
            autoComplete="off"
            spellCheck={false}
            role="combobox"
            aria-expanded={groups.length > 0}
            aria-controls="quickfire-results"
            aria-label={
              argSession
                ? argSession.activeLabel
                : replyingToConversation
                  ? "Reply to this conversation"
                : "Run a command, go to a panel, or ask"
            }
            placeholder={replyingToConversation ? "Reply…" : placeholder}
            defaultValue={inputValue}
            onChange={(event) => {
              fitInputToContent(event.currentTarget);
              emit({ type: "input", value: event.currentTarget.value });
            }}
            onKeyDown={onKeyDown}
          />
        </span>
        {compose?.streaming ? (
          <button
            type="button"
            className="quickfire-stop"
            aria-label="Stop the turn in flight"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => emit({ type: "stop" })}
          >
            <span className="quickfire-stop-mark" aria-hidden="true" />
            Stop
          </button>
        ) : null}
      </div>

      {argSession?.error ? (
        <p className="quickfire-error">{argSession.error}</p>
      ) : null}

      {argSession || conversing ? null : (
        <div className="quickfire-modes" aria-label="Search scope">
          {QUICKFIRE_MODE_CHIPS.map((chip) => (
            <button
              key={chip.mode}
              type="button"
              className="quickfire-mode"
              aria-pressed={mode === chip.mode}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => emit({ type: "mode", mode: chip.mode })}
            >
              {chip.label}
            </button>
          ))}
        </div>
      )}

      {compose ? (
        <div
          className="quickfire-body"
          ref={bodyRef}
          onScroll={(event) => {
            if (missedNew && event.currentTarget.scrollTop < 80)
              setMissedNew(false);
          }}
        >
          <ConversationBody
            compose={compose}
            now={Date.now()}
            onIntent={(intent) => emit(conversationIntent(intent))}
            onCardAction={(action, value) => {
              if (action === "reveal-image" && value) {
                emit({ type: "reveal-image", imageId: value });
              } else if (action === "retry" && value) {
                emit({ type: "send", text: value });
              } else {
                emit({ type: "promote" });
              }
            }}
            leading={
              missedNew ? (
                <button
                  type="button"
                  className="quickfire-new-below"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    const body = bodyRef.current;
                    if (body) body.scrollTop = 0;
                    setMissedNew(false);
                  }}
                >
                  ↑ New reply
                </button>
              ) : compose.disabledReason || compose.promoted ? null : (
                <p className="quickfire-compose-keys">
                  <kbd>⏎</kbd> send · <kbd>⇧⏎</kbd> newline · <kbd>⌘⏎</kbd> open
                  as chat panel
                </p>
              )
            }
          />
        </div>
      ) : groups.length > 0 ? (
        <div
          className="quickfire-results"
          id="quickfire-results"
          role="listbox"
          ref={listRef}
        >
          {groups.map((group) => (
            <section
              key={group.key}
              role="group"
              aria-labelledby={`quickfire-group-${group.key}`}
            >
              <h2
                className="quickfire-group-label"
                id={`quickfire-group-${group.key}`}
              >
                {group.label}
              </h2>
              {group.rows.map((row) => (
                <Row
                  key={row.id}
                  row={row}
                  selected={row.id === selectedId}
                  flashing={row.id === flashRowId}
                  emit={emit}
                />
              ))}
            </section>
          ))}
        </div>
      ) : emptyMessage ? (
        <p className="quickfire-empty">{emptyMessage}</p>
      ) : null}

      <div className="quickfire-context" data-overlay-drag-handle="">
        <button
          type="button"
          className="quickfire-context-panel"
          // Which panel this acts on is a choice, not a readout: §4.1 always
          // said clicking here retargets, so you can quickfire a panel you are
          // not looking at.
          aria-label="Choose which panel this acts on"
          title="Choose which panel this acts on"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => emit({ type: "retarget" })}
        >
          {context ? (
            <>
              <span aria-hidden="true">{context.icon ?? "▤"}</span>
              <span
                className={context.lost ? "quickfire-context-lost" : undefined}
              >
                {context.lost ? "panel closed" : context.title}
              </span>
            </>
          ) : (
            <span className="quickfire-context-lost">no panel focused</span>
          )}
          <span className="quickfire-context-swap" aria-hidden="true">
            ⇄
          </span>
        </button>
        <span className="quickfire-context-hints">
          {argSession ? (
            <>
              <kbd>⏎</kbd> choose · <kbd>⌫</kbd> back · <kbd>esc</kbd>
            </>
          ) : conversing ? (
            <>
              <kbd>⌘K</kbd> palette · <kbd>esc</kbd> close
            </>
          ) : (
            <>
              <kbd>↑↓</kbd> select · <kbd>⏎</kbd> run · <kbd>esc</kbd>
            </>
          )}
        </span>
      </div>
    </div>
  );
}

/**
 * The shared conversation emits product intents; the overlay's wire protocol is
 * the chrome's intent union. They are deliberately different vocabularies —
 * "show older" is a rendering decision the chrome makes against the session,
 * while "open the chat panel" is promotion by another name.
 */
function conversationIntent(intent: ConversationIntent): QuickfireIntent {
  switch (intent.kind) {
    case "clear":
      return { type: "clear" };
    case "promote":
      return { type: "promote" };
    case "focus-promoted":
      return { type: "focus-promoted" };
    case "start-fresh":
      return { type: "start-fresh" };
    case "show-older":
      return { type: "show-older" };
    case "stop":
      return { type: "stop" };
    case "send":
      return { type: "send", text: intent.text };
    case "retarget":
      return { type: "retarget" };
  }
}

function Row({
  row,
  selected,
  flashing,
  emit,
}: {
  row: QuickfireRow;
  selected: boolean;
  flashing: boolean;
  emit: (intent: QuickfireIntent) => void;
}) {
  return (
    <button
      type="button"
      className="quickfire-row"
      data-row-id={row.id}
      data-danger={row.danger ? "" : undefined}
      data-flash={flashing ? "" : undefined}
      role="option"
      aria-selected={selected}
      aria-disabled={row.disabled || undefined}
      disabled={row.disabled}
      // Keep the caret in the input: a mousedown here would blur it first.
      onMouseDown={(event) => event.preventDefault()}
      onMouseMove={() => {
        if (!selected) emit({ type: "select", rowId: row.id });
      }}
      onClick={() => emit({ type: "activate", rowId: row.id })}
    >
      <span className="quickfire-row-icon" aria-hidden="true">
        {row.icon ?? "›"}
      </span>
      <span className="quickfire-row-text">
        <span className="quickfire-row-title">
          {splitTextByMatchRanges(row.title, row.titleRanges).map(
            (part, index) =>
              part.highlighted ? (
                <mark key={index} className="quickfire-mark">
                  {part.text}
                </mark>
              ) : (
                <span key={index}>{part.text}</span>
              ),
          )}
        </span>
        {row.meta ? (
          <span className="quickfire-row-meta">{row.meta}</span>
        ) : null}
      </span>
      <span className="quickfire-row-trailing">
        {row.badge ? (
          <span className="quickfire-row-badge">{row.badge}</span>
        ) : null}
        {row.accelerator ? <kbd>{row.accelerator}</kbd> : null}
      </span>
    </button>
  );
}
