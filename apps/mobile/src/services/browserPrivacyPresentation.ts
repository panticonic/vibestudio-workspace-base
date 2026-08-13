import {
  BrowserPrivacySectionSchema,
  type BrowserPrivacySection,
} from "@vibestudio/service-schemas/browserPrivacy";

export type MobileBrowserPrivacySection = Exclude<BrowserPrivacySection, "export">;

/** Durable across transport reconnects; the trusted shell owns presentation. */
export class BrowserPrivacyPresentationState {
  private readonly listeners = new Set<(section: MobileBrowserPrivacySection) => void>();
  private pending: {
    section: MobileBrowserPrivacySection;
    resolve: () => void;
  } | null = null;

  accept(value: unknown): Promise<void> {
    const section = BrowserPrivacySectionSchema.parse(value ?? "credentials");
    if (section === "export") {
      return Promise.reject(
        new Error("Protected browser-data export is available in the Vibestudio desktop app."),
      );
    }
    if (this.listeners.size > 0) {
      for (const listener of this.listeners) listener(section);
      return Promise.resolve();
    }
    if (this.pending) {
      this.pending.resolve();
    }
    return new Promise<void>((resolve) => {
      this.pending = { section, resolve };
    });
  }

  subscribe(listener: (section: MobileBrowserPrivacySection) => void): () => void {
    this.listeners.add(listener);
    if (this.pending !== null) {
      const pending = this.pending;
      this.pending = null;
      listener(pending.section);
      pending.resolve();
    }
    return () => this.listeners.delete(listener);
  }

  clear(): void {
    this.listeners.clear();
    this.pending?.resolve();
    this.pending = null;
  }
}
