import { useEffect, useRef, useState } from "react";
import { useAtom, useSetAtom } from "jotai";
import {
  Badge,
  Box,
  Button,
  Callout,
  Flex,
  Heading,
  Spinner,
  Text,
  TextField,
} from "@radix-ui/themes";
import { TemplateBrowser } from "@workspace/template-management/react";
import type { HubWorkspaceEntry } from "@vibestudio/service-schemas/hubControl";
import { useShellWorkspaceClient } from "../shell/workspaceContext";
import { systemWorkspaceId } from "../shell/client";
import { useApprovalPresentation } from "./ApprovalPresentationContext";
import { workspaceLabel } from "../shell/workspaceLabel";
import {
  workspaceChooserDialogOpenAtom,
  workspaceChooserTemplateAtom,
} from "../state/appModeAtoms";

export function WorkspaceChooser() {
  const { hubControl, templates } = useShellWorkspaceClient();
  const approvalPresentation = useApprovalPresentation();
  const close = useSetAtom(workspaceChooserDialogOpenAtom);
  const [template, setTemplate] = useAtom(workspaceChooserTemplateAtom);
  const [workspaces, setWorkspaces] = useState<HubWorkspaceEntry[]>([]);
  const [mode, setMode] = useState<"list" | "blank" | "source">(
    template ? "source" : "list",
  );
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<HubWorkspaceEntry | null>(null);
  const pending = useRef(false);
  useEffect(() => {
    let live = true;
    hubControl
      .listWorkspaces()
      .then((entries) => {
        if (live) setWorkspaces(entries);
      })
      .catch((error) => {
        if (live) setError(String(error));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [hubControl]);
  useEffect(() => {
    if (template) setMode("source");
  }, [template]);
  const open = async (workspaceId: string) => {
    setBusy(true);
    setError(null);
    try {
      await hubControl.routeWorkspace({ workspaceId });
      setTemplate(null);
      close(false);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const create = async (
    workspace: string,
    rootTemplate?: import("@vibestudio/service-schemas/templates").TemplateExactPin,
  ) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const entry = await hubControl.createWorkspace({
        workspace,
        ...(rootTemplate ? { rootTemplate } : {}),
      });
      setCreated(entry);
      await open(entry.workspaceId);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <Box p="0" style={{ maxHeight: "80vh", overflow: "auto" }}>
      <Flex direction="column" gap="4">
        <Flex align="center" justify="between" gap="3">
          {mode === "source" && !created ? (
            <Text size="2" color="gray">
              Workspaces
            </Text>
          ) : (
            <Heading size="5">
              {created
                ? `${created.name} is ready`
                : mode === "list"
                  ? "Choose where to work"
                  : "Room for a new idea"}
            </Heading>
          )}
          {mode !== "list" && !created ? (
            <Button
              variant="ghost"
              color="gray"
              size="3"
              disabled={busy}
              onClick={() => {
                setMode("list");
                setTemplate(null);
                setError(null);
              }}
            >
              All workspaces
            </Button>
          ) : null}
        </Flex>
        {error ? (
          <Callout.Root color="red" role="alert">
            <Callout.Text>{error}</Callout.Text>
          </Callout.Root>
        ) : null}
        {created ? (
          <Button
            size="3"
            disabled={busy}
            onClick={() => void open(created.workspaceId)}
          >
            Open workspace
          </Button>
        ) : mode === "source" ? (
          <TemplateBrowser
            client={templates}
            initialPin={template ?? undefined}
            onCreate={create}
            onReviewPending={(approvalId) => {
              void systemWorkspaceId
                .then((ownerId) => {
                  approvalPresentation.request(ownerId, approvalId);
                  close(false);
                })
                .catch((cause: unknown) => {
                  setError(
                    cause instanceof Error ? cause.message : String(cause),
                  );
                });
            }}
          />
        ) : mode === "blank" ? (
          <Flex direction="column" gap="3">
            <Text size="2" color="gray">
              Start with the shared basics and make it your own.
            </Text>
            <label>
              <Text as="div" size="2" weight="medium" mb="2">
                Workspace name
              </Text>
              <TextField.Root
                size="3"
                aria-label="Workspace name"
                placeholder="my-project"
                value={name}
                onChange={(event) => setName(event.target.value)}
                disabled={busy}
              />
            </label>
            <Text size="1" color="gray">
              Use letters, numbers, hyphens or underscores.
            </Text>
            <Button
              size="3"
              loading={busy}
              disabled={busy || !/^[A-Za-z0-9_-]+$/.test(name.trim())}
              onClick={() => void create(name.trim())}
            >
              Create workspace
            </Button>
          </Flex>
        ) : (
          <>
            <Text size="2" color="gray">
              Each workspace keeps its own panels, files and conversations.
            </Text>
            {loading ? (
              <Flex gap="2" role="status">
                <Spinner />
                <Text size="2">Loading workspaces…</Text>
              </Flex>
            ) : null}
            <Flex direction="column" gap="2">
              {workspaces.map((workspace) => (
                <Button
                  key={workspace.workspaceId}
                  size="3"
                  variant="surface"
                  color="gray"
                  disabled={busy}
                  onClick={() => void open(workspace.workspaceId)}
                  style={{ justifyContent: "space-between", minHeight: 56 }}
                >
                  <Text weight="medium">{workspaceLabel(workspace)}</Text>
                  <Badge color="gray">
                    {workspace.privateRole ? "Only you" : "Workspace"}
                  </Badge>
                </Button>
              ))}
            </Flex>
            <Flex gap="3" wrap="wrap" mt="2">
              <Button size="3" onClick={() => setMode("blank")}>
                New workspace
              </Button>
              <Button size="3" variant="soft" onClick={() => setMode("source")}>
                Explore apps & sources
              </Button>
            </Flex>
          </>
        )}
      </Flex>
    </Box>
  );
}
