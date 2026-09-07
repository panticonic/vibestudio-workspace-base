import type {
  TemplateAuthoringInspection,
  TemplateAuthoringIntent,
  TemplateCatalogSnapshot,
  TemplateInspection,
  TemplateLocator,
  TemplatePublication,
} from "@vibestudio/service-schemas/templates";

const TEMPLATES = "@workspace-extensions/templates";

export interface TemplateManagementClient {
  catalog(options?: { refresh?: boolean }): Promise<TemplateCatalogSnapshot | null>;
  inspect(locator: TemplateLocator): Promise<TemplateInspection>;
  inspectAuthoring(input: TemplateAuthoringIntent): Promise<TemplateAuthoringInspection>;
  authoringParts(): Promise<Array<{ repoPath: string; packageName?: string }>>;
  publishAuthoring(input: {
    commandId: string; intent: TemplateAuthoringIntent; expectedFingerprint: string; version: string;
    destination: { provider: string; owner: string; name: string }; credentialId?: string;
    creation?: { private?: boolean; description?: string };
  }): Promise<TemplatePublication>;
  suggestRegistryEntry(input: {
    commandId: string; catalog: TemplateCatalogSnapshot; publication: TemplatePublication; credential?: string;
    entry: { id: string; name: string; description: string; tags: string[]; recommended: boolean }; revision: string;
  }): Promise<unknown>;
}

export function createTemplateManagementClient(
  invoke: (extension: string, method: string, args: unknown[]) => Promise<unknown>,
): TemplateManagementClient {
  return {
    catalog: (options) => invoke(TEMPLATES, "catalog", options ? [options] : []) as Promise<TemplateCatalogSnapshot | null>,
    inspect: (locator) => invoke(TEMPLATES, "inspect", [locator]) as Promise<TemplateInspection>,
    inspectAuthoring: (input) => invoke(TEMPLATES, "inspectAuthoring", [input]) as Promise<TemplateAuthoringInspection>,
    authoringParts: () => invoke(TEMPLATES, "authoringParts", []) as Promise<Array<{ repoPath: string; packageName?: string }>>,
    publishAuthoring: (input) => invoke(TEMPLATES, "publishAuthoring", [input]) as Promise<TemplatePublication>,
    suggestRegistryEntry: (input) => invoke(TEMPLATES, "suggestRegistryEntry", [input]),
  };
}
