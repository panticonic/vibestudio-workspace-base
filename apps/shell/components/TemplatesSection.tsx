import { useSetAtom } from "jotai";
import { Tabs } from "@radix-ui/themes";
import { TemplateBrowser } from "@workspace/react/templates";
import { useShellWorkspaceClient } from "../shell/workspaceContext";
import {
  settingsDialogAtom,
  workspaceChooserDialogOpenAtom,
  workspaceChooserTemplateAtom,
} from "../state/appModeAtoms";
import { SourceCopySection } from "./SourceCopySection";
import { systemWorkspaceId } from "../shell/client";
import { useApprovalPresentation } from "./ApprovalPresentationContext";

export function TemplatesSection(
  props: { showHeading?: boolean; initialWorkspaceId?: string } = {},
) {
  return (
    <Tabs.Root defaultValue="create">
      <Tabs.List aria-label="Workspace sources">
        <Tabs.Trigger value="create">Create workspace</Tabs.Trigger>
        <Tabs.Trigger value="copy">Copy selected files</Tabs.Trigger>
      </Tabs.List>
      <Tabs.Content value="create">
        <TemplateCreationSection />
      </Tabs.Content>
      <Tabs.Content value="copy">
        <SourceCopySection initialWorkspaceId={props.initialWorkspaceId} />
      </Tabs.Content>
    </Tabs.Root>
  );
}

function TemplateCreationSection() {
  const { templates, credentials } = useShellWorkspaceClient();
  const approvalPresentation = useApprovalPresentation();
  const closeSettings = useSetAtom(settingsDialogAtom);
  const openWorkspaceChooser = useSetAtom(workspaceChooserDialogOpenAtom);
  const selectTemplate = useSetAtom(workspaceChooserTemplateAtom);
  return (
    <TemplateBrowser
      client={templates}
      listSourceAccounts={credentials.listStoredCredentials}
      onReviewPending={(approvalId) => {
        void systemWorkspaceId.then((ownerId) => {
          approvalPresentation.request(ownerId, approvalId);
        });
      }}
      onOpenInApp={async ({ pin }) => {
        selectTemplate(pin);
        closeSettings(null);
        openWorkspaceChooser(true);
      }}
    />
  );
}
