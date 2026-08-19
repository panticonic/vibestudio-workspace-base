import type { ReactNode } from "react";

export interface SceneFrameProps {
  eyebrow: string;
  title: ReactNode;
  lede?: ReactNode;
  children?: ReactNode;
}

/** The typographic frame every scene shares: eyebrow, title, lede, then figures. */
export function SceneFrame({ eyebrow, title, lede, children }: SceneFrameProps) {
  return (
    <section className="scene" aria-labelledby="scene-title">
      <header>
        <div className="scene__eyebrow">{eyebrow}</div>
        <h1 className="scene__title" id="scene-title">
          {title}
        </h1>
      </header>
      {lede ? <div className="scene__lede">{lede}</div> : null}
      {children}
    </section>
  );
}

export function Figure({
  children,
  caption,
  flush,
}: {
  children: ReactNode;
  caption?: ReactNode;
  flush?: boolean;
}) {
  return (
    <figure className={`figure${flush ? " figure--flush" : ""}`} style={{ margin: 0 }}>
      {children}
      {caption ? <figcaption className="figure__caption">{caption}</figcaption> : null}
    </figure>
  );
}

export function Choices<T extends string>({
  value,
  options,
  onChange,
  label,
  danger,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (next: T) => void;
  label: string;
  danger?: T[];
}) {
  return (
    <div className="choices" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`choice${danger?.includes(option.value) ? " choice--danger" : ""}`}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
