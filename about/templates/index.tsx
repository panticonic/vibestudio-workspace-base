import { credentialsMethods } from "@vibestudio/service-schemas/credentials";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import { extensions, rpc } from "@workspace/runtime";
import { createShellSurfaceLink } from "@vibestudio/shared/shellSurface";
import { createTemplateManagementClient } from "@workspace/template-management";
import { TemplateBrowser } from "@workspace/react/templates";
import { AboutPage, AboutThemeRoot } from "@workspace/about-shared/ui";

const templates = createTemplateManagementClient((extension, method, args) =>
  extensions.invoke(extension, method, args),
);
const accounts = createTypedServiceClient(
  "credentials",
  credentialsMethods,
  (service, method, args) => rpc.call("main", `${service}.${method}`, args),
);
const listSourceAccounts = () => accounts.listStoredCredentials();
export default function TemplatesPage() {
  return (
    <AboutThemeRoot>
      <AboutPage title="Workspaces">
        <TemplateBrowser
          client={templates}
          listSourceAccounts={listSourceAccounts}
          onOpenInApp={async ({ pin }) => {
            window.location.assign(
              createShellSurfaceLink({
                kind: "workspace-chooser",
                template: pin,
              }),
            );
          }}
        />
      </AboutPage>
    </AboutThemeRoot>
  );
}
