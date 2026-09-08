import {
  submitWorkspaceCreation,
  readWorkspaceCreationSubmission,
} from "@vibestudio/service-schemas/clients/workspaceCreationClient";
import type { WorkspaceCreationReceipt } from "@vibestudio/workspace-contracts/types";
import { useEffect, useRef, useState } from "react";
import { useAtom, useSetAtom } from "jotai";
import {
  Box,
  Button,
  Callout,
  Flex,
  Spinner,
  Text,
  TextField,
} from "@radix-ui/themes";
import { TemplateBrowser } from "@workspace/react/templates";
import { sameWorkspaceTemplatePin } from "@vibestudio/workspace-contracts/types";
import {
  useShellWorkspaceClient,
  useWorkspaceDesktopHost,
} from "../shell/workspaceContext";
import { systemWorkspaceId } from "../shell/client";
import { useApprovalPresentation } from "./ApprovalPresentationContext";
import {
  workspaceChooserDialogOpenAtom,
  workspaceChooserTemplateAtom,
  workspaceCreationSourceUrlAtom,
} from "../state/appModeAtoms";

export function WorkspaceChooser() {
  const { hubControl, templates } = useShellWorkspaceClient();
  const desktop = useWorkspaceDesktopHost();
  const approvalPresentation = useApprovalPresentation();
  const close = useSetAtom(workspaceChooserDialogOpenAtom);
  const [sourceUrl, setSourceUrl] = useAtom(workspaceCreationSourceUrlAtom);
  const [template, setTemplate] = useAtom(workspaceChooserTemplateAtom);
  const [mode, setMode] = useState<"blank" | "source">("source");
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<WorkspaceCreationReceipt | null>(null);
  const [candidateDiscovery, setCandidateDiscovery] = useState<
    | { status: "loading" }
    | { status: "failed"; error: string }
    | {
        status: "ready";
        candidates: import("@vibestudio/service-schemas/templates").TemplateInspection[];
      }
  >({ status: "loading" });
  const templateCandidates =
    candidateDiscovery.status === "ready" ? candidateDiscovery.candidates : [];
  const localInspection = templateCandidates.find(
    ({ pin }) => template !== null && sameWorkspaceTemplatePin(pin, template),
  );
  const pending = useRef(false);
  const [restoring, setRestoring] = useState(true);
  const [recoveryNotice, setRecoveryNotice] = useState("");
  const [recoveredInput, setRecoveredInput] =
    useState<ReturnType<typeof readWorkspaceCreationSubmission>>(null);
  useEffect(() => {
    let live = true;
    void hubControl
      .getProfile(undefined)
      .then((profile) => {
        if (!live) return;
        if (!profile)
          throw new Error("The authenticated account is unavailable.");
        const saved = readWorkspaceCreationSubmission(
          localStorage.getItem(`workspace-creation:${profile.userId}`),
        );
        if (saved) {
          setRecoveredInput(saved);
          setName(saved.workspace);
          setTemplate(saved.rootTemplate ?? null);
          setMode(saved.rootTemplate ? "source" : "blank");
          setRecoveryNotice(
            `A previous creation of ${saved.workspace} may have completed. Continue to check its result before submitting anything again.`,
          );
        }
      })
      .catch((error) => {
        if (live) setError(String(error));
      })
      .finally(() => {
        if (live) setRestoring(false);
      });
    return () => {
      live = false;
    };
  }, [hubControl, setTemplate]);
  useEffect(() => {
    let live = true;
    hubControl
      .listTemplateCandidates()
      .then((candidates) => {
        if (live) setCandidateDiscovery({ status: "ready", candidates });
      })
      .catch((cause: unknown) => {
        if (live)
          setCandidateDiscovery({
            status: "failed",
            error: `Could not load workspace sources: ${cause instanceof Error ? cause.message : String(cause)}`,
          });
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
      await desktop.openWorkspace(workspaceId);
      setTemplate(null);
      setSourceUrl(null);
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
    if (pending.current || restoring) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const profile = await hubControl.getProfile(undefined);
      if (!profile)
        throw new Error(
          "The authenticated account is unavailable; workspace creation was not submitted.",
        );
      const entry = await submitWorkspaceCreation(
        hubControl,
        {
          workspace,
          ...(rootTemplate ? { rootTemplate } : {}),
        },
        {
          key: `workspace-creation:${profile.userId}`,
          getItem: (key) => localStorage.getItem(key),
          setItem: (key, value) => localStorage.setItem(key, value),
          removeItem: (key) => localStorage.removeItem(key),
          newOperationId: () => crypto.randomUUID(),
        },
      );
      setRecoveredInput(null);
      setRecoveryNotice("");
      if (entry.state === "deleted")
        throw new Error(
          "The earlier creation completed, but its workspace was deleted. Choose Create again only to install a new workspace.",
        );
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
        {!created && !template && !recoveredInput ? (
          <Flex gap="2" role="group" aria-label="Workspace starting point">
            <Button
              variant={mode === "source" ? "solid" : "soft"}
              disabled={busy}
              onClick={() => setMode("source")}
            >
              From an example or source
            </Button>
            <Button
              variant={mode === "blank" ? "solid" : "soft"}
              disabled={busy}
              onClick={() => setMode("blank")}
            >
              Start blank
            </Button>
          </Flex>
        ) : null}
        {recoveryNotice ? (
          <Callout.Root>
            <Callout.Text>{recoveryNotice}</Callout.Text>
          </Callout.Root>
        ) : null}
        {candidateDiscovery.status === "failed" ? (
          <Callout.Root color="red" role="alert">
            <Callout.Text>{candidateDiscovery.error}</Callout.Text>
          </Callout.Root>
        ) : null}
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
        ) : restoring ? (
          <Spinner />
        ) : recoveredInput ? (
          <Button
            disabled={busy}
            onClick={() =>
              void create(recoveredInput.workspace, recoveredInput.rootTemplate)
            }
          >
            Continue previous creation
          </Button>
        ) : mode === "source" &&
          template &&
          candidateDiscovery.status === "loading" ? (
          <Flex gap="2" role="status">
            <Spinner />
            <Text size="2">Loading workspace source…</Text>
          </Flex>
        ) : mode === "source" &&
          template &&
          candidateDiscovery.status === "failed" ? null : mode === "source" ? (
          <TemplateBrowser
            client={templates}
            onChooseFolder={desktop.inspectWorkspaceFolder}
            initialSourceUrl={sourceUrl ?? undefined}
            candidates={templateCandidates}
            initialInspection={localInspection}
            initialPin={localInspection ? undefined : (template ?? undefined)}
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
        ) : (
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
        )}
      </Flex>
    </Box>
  );
}
