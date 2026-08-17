/**
 * The "quickfire" overlay surface: the palette card floating over the live
 * panel. Pure view — props in, intents out, no RPC (the chrome-side
 * `QuickfireOwner` holds every piece of state and performs every call).
 *
 * The one thing this surface owns locally is the text input's value. Round
 * tripping each keystroke to the chrome and back would make typing stutter, so
 * the input is uncontrolled and merely *echoes* changes upward; the chrome
 * overwrites it only when it deliberately wants to (mode chips, popping an
 * argument, restoring a query), which it signals by bumping `inputEpoch`.
 */
import { useEffect, useLayoutEffect, useRef } from "react";
import {
  QUICKFIRE_MODE_CHIPS,
  isQuickfireSurfaceProps,
  type QuickfireIntent,
  type QuickfireRow,
  type QuickfireSurfaceProps,
} from "./quickfireSurfaceModel";
import { parseQuickfireMarkdown } from "@workspace/quickfire-core";
import type {
  QuickfireMarkdownInline,
  QuickfireToolCall,
  QuickfireTranscriptEntry,
} from "@workspace/quickfire-core";
import type { OverlaySurfaceComponentProps } from "./types";
import "./quickfire.css";

export function QuickfireSurface({
  props,
  emitIntent,
}: OverlaySurfaceComponentProps) {
  if (!isQuickfireSurfaceProps(props)) return null;
  return (
    <QuickfireCard
      {...props}
      emit={emitIntent as (intent: QuickfireIntent) => void}
    />
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
  const inputRef = useRef<HTMLInputElement>(null);
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

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const atEnd = input.selectionStart === input.value.length;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        emit({ type: "move", delta: 1 });
        return;
      case "ArrowUp":
        event.preventDefault();
        emit({ type: "move", delta: -1 });
        return;
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
        if (event.shiftKey) return;
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
        emit({ type: "cycle-mode" });
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
    const onKeyDown = (event: KeyboardEvent) => {
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
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [emit]);

  return (
    <div className="quickfire-card" role="dialog" aria-label="Command palette">
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
            ⌕
          </span>
        )}
        <span className="quickfire-input-wrap">
          {ghostSuffix ? (
            <span className="quickfire-ghost" aria-hidden="true">
              <span className="quickfire-ghost-typed">{inputValue}</span>
              <span className="quickfire-ghost-suffix">{ghostSuffix}</span>
            </span>
          ) : null}
          <input
            ref={inputRef}
            className="quickfire-input"
            type="text"
            autoComplete="off"
            spellCheck={false}
            role="combobox"
            aria-expanded={groups.length > 0}
            aria-controls="quickfire-results"
            aria-label={
              argSession
                ? argSession.activeLabel
                : "Run a command, go to a panel, or ask"
            }
            placeholder={placeholder}
            defaultValue={inputValue}
            onChange={(event) =>
              emit({ type: "input", value: event.target.value })
            }
            onKeyDown={onKeyDown}
          />
        </span>
      </div>

      {argSession?.error ? (
        <p className="quickfire-error">{argSession.error}</p>
      ) : null}

      {argSession ? null : (
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
        <QuickfireConversation compose={compose} emit={emit} />
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

      <div className="quickfire-context">
        <span className="quickfire-context-panel">
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
        </span>
        <span className="quickfire-context-hints">
          {argSession ? (
            <>
              <kbd>⏎</kbd> choose · <kbd>⌫</kbd> back · <kbd>esc</kbd>
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
 * The `/` mode conversation (§4.3). Pure view: every affordance emits an intent
 * and the chrome decides what it means.
 */
function QuickfireConversation({
  compose,
  emit,
}: {
  compose: NonNullable<QuickfireSurfaceProps["compose"]>;
  emit: (intent: QuickfireIntent) => void;
}) {
  const newestFirst = compose.transcriptOrder === "newest-first";
  // Keep the newest message in view. Which edge that is depends on the order:
  // reading downward from the input, "newest" is the top of the list, and
  // scrolling to the bottom would walk away from the reply that just arrived.
  const newestRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    newestRef.current?.scrollIntoView({ block: newestFirst ? "start" : "end" });
  }, [compose.transcript, newestFirst]);

  if (compose.promoted) {
    return (
      <div className="quickfire-compose">
        <p className="quickfire-compose-hint">
          This conversation continues in a chat panel, which now owns it.
        </p>
        <div className="quickfire-compose-actions">
          <button
            type="button"
            className="quickfire-action"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => emit({ type: "focus-promoted" })}
          >
            continued in chat panel →
          </button>
          <button
            type="button"
            className="quickfire-action"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => emit({ type: "start-fresh" })}
          >
            start a new conversation here
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="quickfire-compose">
      <div className="quickfire-conversation-header">
        <span className="quickfire-conversation-title">
          ✦ {compose.panelTitle}
        </span>
        <span className="quickfire-conversation-actions">
          {/* Both conversation exits are spelled out side by side: throw it
              away, or move it somewhere it can grow. */}
          {compose.kind === "conversation" ? null : (
            <button
              type="button"
              className="quickfire-action"
              disabled={!compose.hasConversation}
              title="Delete this panel's conversation"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => emit({ type: "clear" })}
            >
              ⟲ Clear
            </button>
          )}
          <button
            type="button"
            className="quickfire-action"
            disabled={!compose.hasConversation}
            title={
              compose.kind === "conversation"
                ? "Open this conversation in its chat panel"
                : "Move this conversation into a chat panel below this one, keeping its history"
            }
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => emit({ type: "promote" })}
          >
            {compose.kind === "conversation"
              ? "⧉ Open chat panel"
              : "⧉ Move to chat panel"}
          </button>
        </span>
      </div>

      {compose.resume ? (
        <div className="quickfire-resume">
          <span>
            Resumed
            {compose.resume.messageCount === null
              ? ""
              : ` · ${compose.resume.messageCount} messages`}
            {compose.resume.lastActivityAt === null
              ? ""
              : ` · ${relativeTime(compose.resume.lastActivityAt)}`}
          </span>
          <button
            type="button"
            className="quickfire-action"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => emit({ type: "promote" })}
          >
            show all →
          </button>
        </div>
      ) : null}

      {compose.credentialRequest ? (
        <div className="quickfire-error">
          <span>
            {compose.credentialRequest.reason ??
              `Model credential required for ${compose.credentialRequest.providerId}.`}
          </span>{" "}
          <button
            type="button"
            className="quickfire-action"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => emit({ type: "promote" })}
          >
            Reconnect in chat →
          </button>
        </div>
      ) : null}

      {/* Newest-first puts the send hint between the input and the newest
          message, where it belongs; oldest-first leaves it after the list. */}
      {newestFirst &&
      compose.transcript.length > 0 &&
      !compose.disabledReason ? (
        <p className="quickfire-compose-keys quickfire-compose-keys-lead">
          ⏎ send · ⇧⏎ newline · ⌘⏎ open as chat panel
        </p>
      ) : null}

      {compose.transcript.length > 0 ? (
        <div className="quickfire-transcript">
          {newestFirst ? <div ref={newestRef} /> : null}
          {compose.olderCount > 0 ? (
            <p className="quickfire-compose-hint">
              {compose.olderCount} older entries hidden
            </p>
          ) : null}
          {compose.transcript.map((entry) => (
            <QuickfireTranscriptRow key={entry.id} entry={entry} />
          ))}
          {newestFirst ? null : <div ref={newestRef} />}
        </div>
      ) : (
        <p
          className="quickfire-compose-hint"
          aria-live={compose.connecting ? "polite" : undefined}
        >
          {compose.connecting ? (
            <span className="quickfire-spinner" aria-hidden="true" />
          ) : null}
          {compose.connecting
            ? compose.kind === "conversation"
              ? "Opening the conversation…"
              : "Starting a conversation about this panel…"
            : compose.hint}
        </p>
      )}

      {compose.error ? (
        <p className="quickfire-error">{compose.error}</p>
      ) : null}

      {compose.disabledReason ? (
        <p className="quickfire-compose-disabled">{compose.disabledReason}</p>
      ) : (
        <p className="quickfire-compose-footer">
          {compose.streaming ? (
            <button
              type="button"
              className="quickfire-action"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => emit({ type: "stop" })}
            >
              ■ stop
            </button>
          ) : null}
          {newestFirst && compose.transcript.length > 0 ? null : (
            <span className="quickfire-compose-keys">
              ⏎ send · ⇧⏎ newline · ⌘⏎ open as chat panel
            </span>
          )}
        </p>
      )}
    </div>
  );
}

function QuickfireTranscriptRow({
  entry,
}: {
  entry: QuickfireTranscriptEntry;
}) {
  if (entry.kind === "thinking") {
    return (
      <details
        className="quickfire-record quickfire-thinking"
        open={entry.streaming || undefined}
      >
        <summary>
          {entry.streaming ? (
            <span className="quickfire-spinner" aria-hidden="true" />
          ) : null}
          {entry.title}
        </summary>
        <QuickfireMarkdown source={entry.text} />
      </details>
    );
  }
  if (entry.kind === "activity") {
    return (
      <div
        className={`quickfire-activity quickfire-activity-${entry.phase}`}
        aria-live="polite"
      >
        <span className="quickfire-activity-status">
          {entry.state === "working" ? (
            <span className="quickfire-spinner" aria-hidden="true" />
          ) : null}
          {entry.label}
        </span>
        {entry.toolCalls?.length ? (
          <QuickfireToolCalls calls={entry.toolCalls} />
        ) : null}
      </div>
    );
  }
  if (entry.kind !== "message") {
    const title =
      entry.kind === "approval"
        ? entry.question
        : entry.title;
    const detail =
      entry.kind === "notice"
        ? entry.detail
        : entry.kind === "approval"
          ? entry.reason
          : undefined;
    return (
      <article
        className={`quickfire-message quickfire-message-${entry.kind}`}
      >
        <h3 className="quickfire-message-author">
          {entry.kind === "approval" ? (
            entry.status === "pending" ? (
              "Approval needed"
            ) : (
              `Approval ${entry.status}`
            )
          ) : (
            entry.title
          )}
        </h3>
        <div className="quickfire-message-text">
          <QuickfireMarkdown
            source={`${title}${detail ? ` — ${detail}` : ""}`}
          />
        </div>
      </article>
    );
  }
  return (
    <article
      className={`quickfire-message quickfire-message-${entry.author}${
        entry.error ? " quickfire-message-error" : ""
      }`}
    >
      <h3 className="quickfire-message-author">{entry.authorLabel}</h3>
      <div className="quickfire-message-text">
        <QuickfireMarkdown source={entry.text} />
        {entry.streaming ? (
          <span className="quickfire-caret" aria-hidden="true" />
        ) : null}
      </div>
      {entry.toolCalls?.length ? (
        <QuickfireToolCalls calls={entry.toolCalls} />
      ) : null}
    </article>
  );
}

function QuickfireToolCalls({ calls }: { calls: QuickfireToolCall[] }) {
  return (
    <div className="quickfire-tool-calls">
      {calls.map((call) => (
        <details
          key={call.id}
          className={`quickfire-record quickfire-tool-${call.state}`}
        >
          <summary>
            {call.state === "running"
              ? "◌ "
              : call.state === "failed"
                ? "✕ "
                : "✓ "}
            {call.name}
          </summary>
          <ToolCallDetails call={call} />
        </details>
      ))}
    </div>
  );
}

function ToolCallDetails({ call }: { call: QuickfireToolCall }) {
  if (!call.input && !call.output && !call.progress?.length && !call.failure) {
    return <p className="quickfire-record-empty">No details were recorded.</p>;
  }
  return (
    <div className="quickfire-record-details">
      {call.input ? <DetailSection label="Input" value={call.input} /> : null}
      {call.progress?.length ? (
        <DetailSection label="Progress" value={call.progress.join("\n")} />
      ) : null}
      {call.output ? (
        <DetailSection label="Output" value={call.output} />
      ) : null}
      {call.failure ? (
        <DetailSection label="Failure" value={call.failure} />
      ) : null}
    </div>
  );
}

function DetailSection({ label, value }: { label: string; value: string }) {
  return (
    <section>
      <h4>{label}</h4>
      <pre>{value}</pre>
    </section>
  );
}

function QuickfireMarkdown({ source }: { source: string }) {
  return parseQuickfireMarkdown(source).map((block, index) => {
    const key = `${block.kind}:${index}`;
    if (block.kind === "code-block") return <pre key={key}>{block.text}</pre>;
    if (block.kind === "heading") {
      return (
        <strong key={key} className="quickfire-markdown-heading">
          <MarkdownInline nodes={block.children} />
        </strong>
      );
    }
    if (block.kind === "bullet-list" || block.kind === "ordered-list") {
      const List = block.kind === "bullet-list" ? "ul" : "ol";
      return (
        <List key={key}>
          {block.items.map((item, itemIndex) => (
            <li key={itemIndex}>
              <MarkdownInline nodes={item} />
            </li>
          ))}
        </List>
      );
    }
    if (block.kind === "quote")
      return (
        <blockquote key={key}>
          <MarkdownInline nodes={block.children} />
        </blockquote>
      );
    return (
      <p key={key}>
        <MarkdownInline nodes={block.children} />
      </p>
    );
  });
}

function MarkdownInline({ nodes }: { nodes: QuickfireMarkdownInline[] }) {
  return nodes.map((node, index) => {
    if (node.kind === "text") return node.text;
    if (node.kind === "code") return <code key={index}>{node.text}</code>;
    if (node.kind === "strong")
      return (
        <strong key={index}>
          <MarkdownInline nodes={node.children} />
        </strong>
      );
    if (node.kind === "emphasis")
      return (
        <em key={index}>
          <MarkdownInline nodes={node.children} />
        </em>
      );
    return (
      <a key={index} href={node.href} target="_blank" rel="noreferrer">
        <MarkdownInline nodes={node.children} />
      </a>
    );
  });
}

/** Coarse, human relative time for the resume chip. Display only. */
function relativeTime(epochMs: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - epochMs) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
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
        <span className="quickfire-row-title">{row.title}</span>
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
