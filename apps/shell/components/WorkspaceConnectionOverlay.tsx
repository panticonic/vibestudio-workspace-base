import {
  Box,
  Button,
  Card,
  Flex,
  Heading,
  Spinner,
  Text,
} from "@radix-ui/themes";
import { CrossCircledIcon } from "@radix-ui/react-icons";
import { useEffect, useState } from "react";
import {
  workspaceConnectionPresentation,
  type WorkspaceConnectionState,
} from "@vibestudio/shared/workspaceConnection";

import { useShellOverlay } from "../shell/useShellOverlay";

const TRANSIENT_OUTAGE_DELAY_MS = 350;

type WorkspaceConnectionBridge = {
  getCurrent(): Promise<WorkspaceConnectionState>;
  onChange(handler: (state: WorkspaceConnectionState) => void): () => void;
};

function connectionBridge(): WorkspaceConnectionBridge {
  const bridge = (
    globalThis as typeof globalThis & {
      __vibestudioWorkspaceConnection?: WorkspaceConnectionBridge;
    }
  ).__vibestudioWorkspaceConnection;
  if (!bridge) throw new Error("Workspace connection bridge is unavailable");
  return bridge;
}

/** One shell-owned availability surface above the complete native panel stack. */
export function WorkspaceConnectionOverlay({
  onOpenSettings,
}: {
  onOpenSettings: () => void;
}) {
  const [state, setState] = useState<WorkspaceConnectionState | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const bridge = connectionBridge();
    let active = true;
    const remove = bridge.onChange((next) => {
      if (active) setState(next);
    });
    void bridge.getCurrent().then((next) => {
      if (active) setState(next);
    });
    return () => {
      active = false;
      remove();
    };
  }, []);

  const phase = state?.phase ?? "starting";
  useEffect(() => {
    if (phase === "ended") {
      setVisible(true);
      return;
    }
    if (phase !== "reconnecting") {
      setVisible(false);
      return;
    }
    const timer = window.setTimeout(
      () => setVisible(true),
      TRANSIENT_OUTAGE_DELAY_MS
    );
    return () => window.clearTimeout(timer);
  }, [phase]);

  useShellOverlay(visible);
  const presentation = state ? workspaceConnectionPresentation(state) : null;
  if (!visible || !presentation) return null;

  return (
    <Box
      role="alertdialog"
      aria-live="assertive"
      aria-label={presentation.title}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "grid",
        placeItems: "center",
        padding: 24,
        boxSizing: "border-box",
        background:
          "color-mix(in srgb, var(--color-background) 94%, transparent)",
        backdropFilter: "blur(10px)",
      }}
    >
      <Card
        size="4"
        style={{ width: "min(540px, 100%)", boxShadow: "0 24px 80px #0008" }}
      >
        <Flex direction="column" gap="4">
          <Flex align="center" gap="3">
            {presentation.showSpinner ? (
              <Spinner size="3" />
            ) : (
              <CrossCircledIcon width="22" height="22" color="var(--red-9)" />
            )}
            <Heading size="5">{presentation.title}</Heading>
          </Flex>
          <Text color="gray" size="3" style={{ lineHeight: 1.55 }}>
            {presentation.message}
          </Text>
          {presentation.retryDetail ? (
            <Text color="gray" size="2">
              {presentation.retryDetail}
            </Text>
          ) : null}
          {presentation.showSettings ? (
            <Flex>
              <Button variant="soft" onClick={onOpenSettings}>
                Connection settings
              </Button>
            </Flex>
          ) : null}
        </Flex>
      </Card>
    </Box>
  );
}
