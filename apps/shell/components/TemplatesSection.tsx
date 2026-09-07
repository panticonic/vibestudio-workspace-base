import { useState } from "react";
import { useSetAtom } from "jotai";
import { Button, Callout, Flex, Text, Tabs } from "@radix-ui/themes";
import { TemplateBrowser } from "@workspace/template-management/react";
import { useShellWorkspaceClient } from "../shell/workspaceContext";
import { settingsDialogAtom } from "../state/appModeAtoms";
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
  const { templates, hubControl } = useShellWorkspaceClient();
  const approvalPresentation = useApprovalPresentation();
  const closeSettings = useSetAtom(settingsDialogAtom);
  const [created, setCreated] = useState<{
    workspaceId: string;
    name: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const open = async (workspaceId: string) => {
    try {
      await hubControl.routeWorkspace({ workspaceId });
      closeSettings(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };
  if (created)
    return (
      <Flex direction="column" gap="3">
        <Text size="4" weight="bold">
          {created.name} is ready
        </Text>
        {error ? (
          <Callout.Root color="red">
            <Callout.Text>{error}</Callout.Text>
          </Callout.Root>
        ) : null}
        <Button size="3" onClick={() => void open(created.workspaceId)}>
          Open workspace
        </Button>
      </Flex>
    );
  return (
    <TemplateBrowser
      client={templates}
      onReviewPending={(approvalId) => {
        void systemWorkspaceId.then((ownerId) => {
          approvalPresentation.request(ownerId, approvalId);
        });
      }}
      onCreate={async (name, pin) => {
        const entry = await hubControl.createWorkspace({
          workspace: name,
          rootTemplate: pin,
        });
        setCreated(entry);
        await open(entry.workspaceId);
      }}
    />
  );
}
