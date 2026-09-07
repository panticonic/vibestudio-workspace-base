import { extensions } from "@workspace/runtime";
import { createShellSurfaceLink } from "@vibestudio/shared/shellSurface";
import { createTemplateManagementClient } from "@workspace/template-management";
import { TemplateBrowser } from "@workspace/template-management/react";
import { AboutPage, AboutThemeRoot } from "@workspace/about-shared/ui";

const templates = createTemplateManagementClient((extension, method, args) =>
  extensions.invoke(extension, method, args),
);
export default function TemplatesPage() {
  return (
    <AboutThemeRoot>
      <AboutPage title="Workspaces">
        <TemplateBrowser
          client={templates}
          onOpenInApp={async ({ pin }) => {
            window.location.assign(createShellSurfaceLink({ kind: "workspace-chooser", template: pin }));
          }}
        />
      </AboutPage>
    </AboutThemeRoot>
  );
}
