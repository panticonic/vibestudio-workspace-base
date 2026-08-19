/**
 * Vibestudio Tour — an explorable presentation of the system.
 *
 * One scene at a time, keyboard-navigable, with draggable numbers, switchable
 * diagrams and small simulations instead of bullet points. The current scene
 * and presenter-notes state live in the panel's state args
 * (`{ scene?: string; notes?: boolean }`, scene ids from ./deck.ts), so
 * reopening the panel resumes where you were and an agent can drive the deck
 * (`panel.stateArgs.setForPanel(id, { scene: "continuum" })`). Unknown scene
 * ids fall back to the opening scene.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "@radix-ui/themes/styles.css";
import "@workspace/ui/foundation.css";
import "@workspace/ui/themes/vibestudio.css";
import "./tour.css";
import { Theme } from "@radix-ui/themes";
import { panel } from "@workspace/runtime";
import {
  useAgentState,
  useHostCommands,
  useIsMobile,
  usePanelTheme,
  usePanelThemeConfig,
  useStateArgs,
} from "@workspace/react";
import { VibestudioLogo } from "@workspace/ui/brand";
import { DECK, sceneIndex } from "./deck";
import { Opening } from "./scenes/Opening";
import { TwoTiers } from "./scenes/TwoTiers";
import { Authority } from "./scenes/Authority";
import { Credentials } from "./scenes/Credentials";
import { Continuum } from "./scenes/Continuum";
import { Automations } from "./scenes/Automations";
import { Provenance } from "./scenes/Provenance";
import { Runtime } from "./scenes/Runtime";
import { Closing } from "./scenes/Closing";

type TourStateArgs = {
  scene?: string;
  notes?: boolean;
};

const SCENE_COUNT_KEYS = Math.min(9, DECK.length);

const HOST_COMMANDS = [
  { id: "tour-next", label: "Next scene", group: "Tour" },
  { id: "tour-prev", label: "Previous scene", group: "Tour" },
  { id: "tour-notes", label: "Toggle presenter notes", group: "Tour" },
  { id: "tour-present", label: "Toggle presentation mode", group: "Tour" },
  { id: "tour-restart", label: "Restart from the beginning", group: "Tour" },
];

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return target.getAttribute("role") === "slider";
}

function Tour() {
  const hostArgs = useStateArgs<TourStateArgs>();
  // Local mirror so navigation is instant and still works on a host that
  // cannot persist state args; host-published changes (an agent driving the
  // deck, a reopen) win whenever they arrive.
  const [args, setArgs] = useState<TourStateArgs>(hostArgs);
  useEffect(() => {
    setArgs(hostArgs);
  }, [hostArgs]);
  const isMobile = useIsMobile();
  const index = sceneIndex(args.scene);
  const notesOpen = args.notes === true;
  const scene = DECK[index]!;
  const stageRef = useRef<HTMLDivElement | null>(null);

  const [present, setPresent] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  // Always persist the complete snapshot: state-arg updates are read-merge-write
  // on the client, so two quick partial writes could clobber each other.
  const update = useCallback((updates: TourStateArgs) => {
    setArgs((current) => {
      const next = { ...current, ...updates };
      void panel.stateArgs.set(next).catch((error: unknown) => {
        console.warn("tour: could not persist state args", error);
      });
      return next;
    });
  }, []);
  const goToIndex = useCallback(
    (next: number) => {
      const clamped = Math.min(DECK.length - 1, Math.max(0, next));
      const target = DECK[clamped];
      if (!target || target.id === scene.id) return;
      update({ scene: target.id });
      stageRef.current?.scrollTo({ top: 0 });
    },
    [scene.id, update]
  );
  const goTo = useCallback((id: string) => goToIndex(sceneIndex(id)), [goToIndex]);
  const toggleNotes = useCallback(() => update({ notes: !notesOpen }), [notesOpen, update]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isEditableTarget(event.target)) return;
      const onButton = event.target instanceof HTMLElement && event.target.tagName === "BUTTON";
      switch (event.key) {
        case "ArrowRight":
        case "PageDown":
          goToIndex(index + 1);
          break;
        case " ":
        case "Enter":
          if (onButton) return;
          goToIndex(index + 1);
          break;
        case "ArrowLeft":
        case "PageUp":
          goToIndex(index - 1);
          break;
        case "Home":
          goToIndex(0);
          break;
        case "End":
          goToIndex(DECK.length - 1);
          break;
        case "n":
        case "N":
          toggleNotes();
          break;
        case "f":
        case "F":
          setPresent((value) => !value);
          break;
        case "?":
          setHelpOpen((value) => !value);
          break;
        case "Escape":
          if (helpOpen) setHelpOpen(false);
          else if (present) setPresent(false);
          else return;
          break;
        default: {
          const digit = Number(event.key);
          if (Number.isInteger(digit) && digit >= 1 && digit <= SCENE_COUNT_KEYS) goToIndex(digit - 1);
          else return;
        }
      }
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goToIndex, helpOpen, index, present, toggleNotes]);

  useHostCommands(HOST_COMMANDS, (id) => {
    if (id === "tour-next") goToIndex(index + 1);
    else if (id === "tour-prev") goToIndex(index - 1);
    else if (id === "tour-notes") toggleNotes();
    else if (id === "tour-present") setPresent((value) => !value);
    else if (id === "tour-restart") goToIndex(0);
  });

  const agentState = useMemo(
    () => ({
      scene: scene.id,
      sceneNumber: index + 1,
      sceneCount: DECK.length,
      title: scene.title,
      notesOpen,
      presentationMode: present,
    }),
    [index, notesOpen, present, scene.id, scene.title]
  );
  useAgentState("tour", agentState);

  let content;
  switch (scene.id) {
    case "opening":
      content = <Opening goTo={goTo} />;
      break;
    case "tiers":
      content = <TwoTiers />;
      break;
    case "authority":
      content = <Authority />;
      break;
    case "credentials":
      content = <Credentials />;
      break;
    case "continuum":
      content = <Continuum />;
      break;
    case "automations":
      content = <Automations />;
      break;
    case "provenance":
      content = <Provenance />;
      break;
    case "runtime":
      content = <Runtime />;
      break;
    default:
      content = <Closing goTo={goTo} />;
  }

  return (
    <div
      className={`tour${isMobile ? " tour--narrow" : ""}${present ? " tour--present" : ""}`}
      style={{ position: "relative" }}
    >
      {isMobile || present ? null : (
        <nav className="tour-rail" aria-label="Scenes">
          <div className="tour-rail__brand">
            <VibestudioLogo size={22} variant="symbol" />
            <span>
              Vibestudio Tour
              <small>
                {index + 1} / {DECK.length}
              </small>
            </span>
          </div>
          {DECK.map((item, i) => (
            <button
              key={item.id}
              type="button"
              className="tour-rail__item"
              aria-current={i === index}
              onClick={() => goToIndex(i)}
            >
              <span className="tour-rail__num">{String(i + 1).padStart(2, "0")}</span>
              <span>{item.title}</span>
            </button>
          ))}
          <div className="tour-rail__spacer" />
          <div className="tour-rail__hint">
            <kbd>←</kbd> <kbd>→</kbd> scenes · <kbd>F</kbd> present · <kbd>N</kbd> notes · <kbd>?</kbd> keys
          </div>
        </nav>
      )}
      <div className="tour-main">
        <div className="tour-stage" ref={stageRef} key={scene.id}>
          {content}
        </div>
        {notesOpen ? (
          <aside className="notes" aria-label="Presenter notes">
            <div className="notes__title">
              Presenter notes · {index + 1}/{DECK.length} · {scene.title}
            </div>
            <ul>
              {scene.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </aside>
        ) : null}
      </div>
      {present ? (
        <div className="tour-present-exit" aria-hidden="true">
          <kbd>Esc</kbd> exits presentation mode
        </div>
      ) : null}
      {helpOpen ? (
        <div className="help" role="dialog" aria-label="Keyboard shortcuts" onClick={() => setHelpOpen(false)}>
          <div className="help__card" onClick={(event) => event.stopPropagation()}>
            <h2>Keys</h2>
            <dl>
              <dt>
                <kbd>→</kbd> <kbd>Space</kbd> <kbd>PgDn</kbd>
              </dt>
              <dd>next scene</dd>
              <dt>
                <kbd>←</kbd> <kbd>PgUp</kbd>
              </dt>
              <dd>previous scene</dd>
              <dt>
                <kbd>1</kbd>–<kbd>{SCENE_COUNT_KEYS}</kbd>
              </dt>
              <dd>jump to a scene</dd>
              <dt>
                <kbd>Home</kbd> <kbd>End</kbd>
              </dt>
              <dd>first / last scene</dd>
              <dt>
                <kbd>N</kbd>
              </dt>
              <dd>presenter notes</dd>
              <dt>
                <kbd>F</kbd>
              </dt>
              <dd>presentation mode (hide the rail)</dd>
              <dt>
                <kbd>?</kbd> <kbd>Esc</kbd>
              </dt>
              <dd>this overlay</dd>
            </dl>
            <p className="box__sub" style={{ marginBottom: 0, marginTop: 12 }}>
              Dotted numbers drag; dotted words cycle; arrow keys work on both.
            </p>
          </div>
        </div>
      ) : null}
      {isMobile ? (
        <div className="tour-dots">
          <button type="button" className="tour-dots__btn" onClick={() => goToIndex(index - 1)} disabled={index === 0} aria-label="Previous scene">
            ‹
          </button>
          <div className="tour-dots__track" role="tablist" aria-label="Scenes">
            {DECK.map((item, i) => (
              <button
                key={item.id}
                type="button"
                className="tour-dots__dot"
                aria-current={i === index}
                aria-label={item.title}
                onClick={() => goToIndex(i)}
              />
            ))}
          </div>
          <button type="button" className="tour-dots__btn" onClick={() => goToIndex(index + 1)} disabled={index === DECK.length - 1} aria-label="Next scene">
            ›
          </button>
        </div>
      ) : null}
    </div>
  );
}

export default function TourPanelRoot() {
  const appearance = usePanelTheme();
  const themeConfig = usePanelThemeConfig();
  return (
    <Theme appearance={appearance} {...themeConfig}>
      <Tour />
    </Theme>
  );
}
