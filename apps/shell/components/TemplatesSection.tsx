import { useEffect, useState } from "react";
import { useSetAtom } from "jotai";
import { Callout, Tabs } from "@radix-ui/themes";
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
  const { templates, hubControl, credentials } = useShellWorkspaceClient();
  const approvalPresentation = useApprovalPresentation();
  const closeSettings = useSetAtom(settingsDialogAtom);
  const openWorkspaceChooser = useSetAtom(workspaceChooserDialogOpenAtom);
  const selectTemplate = useSetAtom(workspaceChooserTemplateAtom);
  const [candidates, setCandidates] = useState<
    import("@vibestudio/service-schemas/templates").TemplateInspection[]
  >([]);
  const [candidateError, setCandidateError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    hubControl
      .listTemplateCandidates()
      .then((value) => {
        if (live) {
          setCandidates(value);
          setCandidateError(null);
        }
      })
      .catch((cause: unknown) => {
        if (live) {
          setCandidates([]);
          setCandidateError(
            cause instanceof Error ? cause.message : String(cause),
          );
        }
      });
    return () => {
      live = false;
    };
  }, [hubControl]);
  return (
    <>
      {candidateError ? (
        <Callout.Root color="red" role="alert">
          <Callout.Text>
            Could not load workspace sources: {candidateError}
          </Callout.Text>
        </Callout.Root>
      ) : null}
      <TemplateBrowser
        client={templates}
        listSourceAccounts={credentials.listStoredCredentials}
        candidates={candidates}
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
    </>
  );
}
