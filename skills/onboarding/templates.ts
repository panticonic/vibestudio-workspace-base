import type { TemplateCatalogSnapshot } from "@workspace/template-registry";

export interface OnboardingTemplateSelection {
  catalogId: string;
  registryCommit: string;
  registrySnapshot: string;
}

export interface OptionalTemplateSnapshot {
  id: string;
  title: string;
  description: string;
  state: "available";
  summary: string;
  observedAt: string;
  selection: OnboardingTemplateSelection;
}

export interface OptionalTemplateSnapshotDependencies {
  catalog?: (options?: { refresh?: boolean }) => Promise<TemplateCatalogSnapshot | null>;
  refreshCatalog?: boolean;
  now?: () => Date;
}

async function templateCatalog(
  options: { refresh?: boolean } = {}
): Promise<TemplateCatalogSnapshot | null> {
  const { extensions } = await import("@workspace/runtime");
  return extensions.invoke(
    "@workspace-extensions/templates",
    "catalog",
    options.refresh ? [{ refresh: true }] : []
  ) as Promise<TemplateCatalogSnapshot | null>;
}

export async function composeOptionalTemplateSnapshot(
  dependencies: OptionalTemplateSnapshotDependencies = {}
): Promise<OptionalTemplateSnapshot[]> {
  try {
    return await loadOptionalTemplateSnapshot(dependencies);
  } catch {
    return [];
  }
}

/** Explicit UI load path. Catalog failures remain visible to the caller. */
export async function loadOptionalTemplateSnapshot(
  dependencies: OptionalTemplateSnapshotDependencies = {}
): Promise<OptionalTemplateSnapshot[]> {
  const observedAt = (dependencies.now?.() ?? new Date()).toISOString();
  const catalog = await (dependencies.catalog ?? templateCatalog)({
    refresh: dependencies.refreshCatalog ?? true,
  });
  if (!catalog) return [];
  return catalog.entries
    .filter((entry) => entry.recommended)
    .map((entry) => {
      return {
        id: `template.${entry.id}`,
        title: entry.name,
        description: entry.description,
        state: "available",
        summary: "Available to inspect and open as a new workspace.",
        observedAt,
        selection: {
          catalogId: entry.id,
          registryCommit: catalog.coordinates.commit,
          registrySnapshot: catalog.coordinates.snapshot,
        },
      } satisfies OptionalTemplateSnapshot;
    });
}
