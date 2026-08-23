import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Dialog,
  Flex,
  Text,
  TextField,
  Callout,
  Box,
  Tabs,
} from "@radix-ui/themes";
import { ExclamationTriangleIcon } from "@radix-ui/react-icons";
import { AppDialog } from "@workspace/ui/overlay";
import type { SettingsSection } from "@vibestudio/shared/shellSurface";
import {
  createConnectDeepLink,
  parseConnectLink,
  type ConnectPairing,
} from "@vibestudio/shared/connect";
import {
  app,
  incomingPairLink,
  remoteCred,
  type RemoteCredCurrent,
} from "../shell/client";
import { useShellOverlay } from "../shell/useShellOverlay";
import { useShellEvent } from "../shell/useShellEvent";
import { PairedDevicesSection } from "./PairedDevicesSection";
import { AppUpdatesSection } from "./AppUpdatesSection";
import { AccountProfileSection } from "./AccountProfileSection";
import { ThemeSettingsControls } from "./ThemeSettings";
import { HostTargetsSection } from "./HostTargetsSection";
import { TemplatesSection } from "./TemplatesSection";

type LiveConnection = {
  status: "connected" | "connecting" | "disconnected";
  isRemote: boolean;
  reconnect?: { phase: string; attempt: number; reason: string };
};

interface Props {
  section: SettingsSection | null;
  onSectionChange: (section: SettingsSection | null) => void;
}

export function ConnectionSettingsDialog({ section, onSectionChange }: Props) {
  const open = section !== null;
  const view = section ?? "connection";
  useShellOverlay(open);
  const [current, setCurrent] = useState<RemoteCredCurrent | null>(null);
  const [pairLink, setPairLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const [showPairingForm, setShowPairingForm] = useState(false);
  const [live, setLive] = useState<LiveConnection | null>(null);

  useEffect(() => {
    if (!open) return;
    app
      .getInfo()
      .then((info) =>
        setLive({
          status: info.connectionStatus ?? "connected",
          isRemote: (info.connectionMode ?? "local") === "remote",
        }),
      )
      .catch((error) => {
        setError(error instanceof Error ? error.message : String(error));
      });
  }, [open]);

  useShellEvent(
    "server-connection-changed",
    useCallback(
      (payload: {
        status: LiveConnection["status"];
        isRemote: boolean;
        reconnect?: LiveConnection["reconnect"];
      }) => {
        setLive((current) => ({
          status: payload.status,
          isRemote: payload.isRemote,
          reconnect:
            payload.reconnect ??
            (payload.status === "connecting" ? current?.reconnect : undefined),
        }));
      },
      [],
    ),
  );

  useEffect(() => {
    // A `vibestudio://connect` link received while the app is already running
    // carries the full WebRTC pairing material (room/fp/code/sig). The
    // bootstrap chooser owns launch-time links, so do not drain its pending
    // buffer here: doing that races the chooser and can reopen a second
    // connection dialog after a successful launch pairing.
    const apply = (pairing: ConnectPairing) => {
      setPairLink(createConnectDeepLink(pairing));
      onSectionChange("connection");
    };
    return incomingPairLink.onLink(apply);
  }, [onSectionChange]);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setConfirmingDisconnect(false);
    setShowPairingForm(false);
    remoteCred
      .getCurrent()
      .then((c) => {
        setCurrent(c);
      })
      .catch((err) => setError(String(err)));
  }, [open]);

  const onPasteLink = () => {
    const raw = window.prompt("Paste Vibestudio pairing link");
    if (!raw) return;
    const parsed = parseConnectLink(raw);
    if (parsed.kind === "error") {
      setError(parsed.reason);
      return;
    }
    setPairLink(raw);
  };

  const savePairing = async () => {
    setError(null);
    const link = pairLink.trim();
    const parsed = parseConnectLink(link);
    if (parsed.kind === "error") {
      setError(parsed.reason);
      return;
    }
    setBusy(true);
    try {
      const res = await remoteCred.pair(link);
      if (!res.ok) {
        setError(res.message ?? "The pairing link is invalid or expired.");
        setBusy(false);
        return;
      }
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const clearAndRelaunch = async () => {
    setBusy(true);
    try {
      await remoteCred.clear();
      await remoteCred.relaunch();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <AppDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onSectionChange(null);
      }}
      maxWidth="820px"
      title="Settings"
      description="Manage your account, this device, and services in the current workspace."
    >
      <Tabs.Root
        value={view}
        onValueChange={(next) => onSectionChange(next as SettingsSection)}
      >
        <Tabs.List aria-label="Settings view" mt="3">
          <Tabs.Trigger value="connection" aria-label="Connection">
            Connection
          </Tabs.Trigger>
          <Tabs.Trigger value="devices" aria-label="Devices">
            Devices
          </Tabs.Trigger>
          <Tabs.Trigger value="profile" aria-label="Profile">
            Profile
          </Tabs.Trigger>
          <Tabs.Trigger value="appearance" aria-label="Appearance">
            Appearance
          </Tabs.Trigger>
          <Tabs.Trigger value="apps" aria-label="Apps">
            Apps
          </Tabs.Trigger>
          <Tabs.Trigger value="hosts" aria-label="Host apps">
            Host apps
          </Tabs.Trigger>
          <Tabs.Trigger value="templates" aria-label="Templates">
            Templates
          </Tabs.Trigger>
        </Tabs.List>

        <Tabs.Content value="connection">
          <Box pt="4">
            <Text as="div" size="3" weight="medium">
              This device&apos;s connection
            </Text>
            <Text as="div" size="2" color="gray" mb="3">
              Choose the Vibestudio server and workspace this copy connects to.
            </Text>
            {current?.isActive ? (
              <Callout.Root size="1" color="green" mb="3">
                <Callout.Text>
                  Currently connected to{" "}
                  {current.workspaceName ??
                    `your server (device ${current.deviceId})`}
                </Callout.Text>
              </Callout.Root>
            ) : current?.configured &&
              live?.isRemote &&
              live.status === "connecting" ? (
              // A transient blip — calm, reassuring, NOT the scary re-pair banner.
              <Callout.Root size="1" color="blue" mb="3">
                <Callout.Text>
                  Reconnecting to your server
                  {live.reconnect?.attempt
                    ? ` — attempt ${live.reconnect.attempt}`
                    : ""}
                  …
                </Callout.Text>
              </Callout.Root>
            ) : current?.configured &&
              live?.isRemote &&
              live.status === "disconnected" ? (
              <Callout.Root size="1" color="amber" mb="3">
                <Callout.Text>
                  Disconnected — Vibestudio will reconnect automatically when
                  your server is reachable.
                </Callout.Text>
              </Callout.Root>
            ) : current?.configured ? (
              <Callout.Root size="1" color="red" mb="3">
                <Callout.Icon>
                  <ExclamationTriangleIcon />
                </Callout.Icon>
                <Callout.Text>
                  The stored device credential is inactive or rejected. Create a
                  fresh pairing link on the server and pair again.
                </Callout.Text>
              </Callout.Root>
            ) : null}

            {current?.configured && !showPairingForm ? (
              <Flex justify="between" align="center" gap="3">
                <Text size="2" color="gray">
                  This device will reconnect automatically with its saved,
                  revocable device identity.
                </Text>
                <Button
                  size="1"
                  variant="soft"
                  onClick={() => setShowPairingForm(true)}
                >
                  Connect to a different server…
                </Button>
              </Flex>
            ) : current ? (
              <Flex direction="column" gap="3">
                {current.configured ? (
                  <Callout.Root size="1" color="amber">
                    <Callout.Icon>
                      <ExclamationTriangleIcon />
                    </Callout.Icon>
                    <Callout.Text>
                      Pairing with another server replaces this device&apos;s
                      saved connection after confirmation and relaunch.
                    </Callout.Text>
                  </Callout.Root>
                ) : (
                  <Text size="2" color="gray">
                    On the server computer, start Vibestudio and scan its QR or
                    paste the complete pairing link below.
                  </Text>
                )}
                <Box>
                  <Flex justify="between" align="end">
                    <Text as="label" size="2" weight="medium">
                      Pairing link
                    </Text>
                    <Button
                      size="1"
                      variant="soft"
                      disabled={busy}
                      onClick={onPasteLink}
                    >
                      Paste link
                    </Button>
                  </Flex>
                  <TextField.Root
                    aria-label="Pairing link"
                    placeholder="https://vibestudio.app/p#…"
                    value={pairLink}
                    onChange={(e) => setPairLink(e.target.value)}
                  />
                </Box>
              </Flex>
            ) : null}

            {error ? (
              <Callout.Root size="1" color="red" mt="3">
                <Callout.Icon>
                  <ExclamationTriangleIcon />
                </Callout.Icon>
                <Callout.Text>{error}</Callout.Text>
              </Callout.Root>
            ) : null}

            <Flex justify="between" mt="5" gap="3">
              <Flex gap="2">
                {live?.isRemote && live.status !== "connected" ? (
                  <Button
                    variant="soft"
                    disabled={busy}
                    onClick={() => {
                      setError(null);
                      void remoteCred
                        .reconnectNow()
                        .catch((err) =>
                          setError(
                            err instanceof Error ? err.message : String(err),
                          ),
                        );
                    }}
                  >
                    Reconnect now
                  </Button>
                ) : null}
                {confirmingDisconnect ? (
                  <>
                    <Button
                      color="red"
                      disabled={busy}
                      onClick={clearAndRelaunch}
                    >
                      Confirm disconnect
                    </Button>
                    <Button
                      variant="soft"
                      color="gray"
                      disabled={busy}
                      onClick={() => setConfirmingDisconnect(false)}
                    >
                      Cancel
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      color="red"
                      variant="soft"
                      disabled={busy || !current?.configured}
                      onClick={() => setConfirmingDisconnect(true)}
                    >
                      Disconnect…
                    </Button>
                  </>
                )}
              </Flex>
              <Flex gap="3">
                <Dialog.Close>
                  <Button variant="soft" color="gray" disabled={busy}>
                    Close
                  </Button>
                </Dialog.Close>
                {current && (!current.configured || showPairingForm) ? (
                  <Button
                    onClick={savePairing}
                    disabled={busy || pairLink.trim().length === 0}
                  >
                    {busy ? "Pairing…" : "Pair & relaunch"}
                  </Button>
                ) : null}
              </Flex>
            </Flex>
          </Box>
        </Tabs.Content>

        <Tabs.Content value="devices">
          <Box pt="4">
            <Text as="div" size="3" weight="medium">
              Devices with access
            </Text>
            <Text as="div" size="2" color="gray" mb="3">
              Connect another device to this workspace or revoke one that should
              no longer have access.
            </Text>
            {current ? (
              <PairedDevicesSection
                currentDeviceId={current.deviceId}
                workspaceName={current.workspaceName}
                onStartPhoneSetup={() => onSectionChange(null)}
                showHeading={false}
              />
            ) : (
              <Text size="2" color="gray">
                Connect this device to a server before managing other devices.
              </Text>
            )}
          </Box>
        </Tabs.Content>

        <Tabs.Content value="profile">
          <Box pt="4">
            <AccountProfileSection active={open && view === "profile"} />
          </Box>
        </Tabs.Content>

        <Tabs.Content value="appearance">
          <Box pt="4" style={{ maxWidth: 420 }}>
            <Text as="div" size="3" weight="medium">
              Appearance
            </Text>
            <Text as="div" size="2" color="gray" mb="3">
              Customize how Vibestudio looks on this device.
            </Text>
            <ThemeSettingsControls />
          </Box>
        </Tabs.Content>

        <Tabs.Content value="apps">
          <Box pt="4">
            <Text as="div" size="3" weight="medium">
              Workspace apps
            </Text>
            <Text as="div" size="2" color="gray" mb="3">
              Inspect, update, restart, or roll back apps running in this
              workspace.
            </Text>
            <AppUpdatesSection showHeading={false} />
          </Box>
        </Tabs.Content>

        <Tabs.Content value="hosts">
          <Box pt="4">
            <Text as="div" size="3" weight="medium">
              Host apps
            </Text>
            <Text as="div" size="2" color="gray" mb="3">
              Choose which installed apps host desktop, mobile, and terminal
              experiences.
            </Text>
            <HostTargetsSection showHeading={false} />
          </Box>
        </Tabs.Content>

        <Tabs.Content value="templates">
          <Box pt="4">
            <TemplatesSection showHeading={false} />
          </Box>
        </Tabs.Content>

        {view !== "connection" ? (
          <Flex justify="end" mt="5">
            <Dialog.Close>
              <Button variant="soft" color="gray">
                Close
              </Button>
            </Dialog.Close>
          </Flex>
        ) : null}
      </Tabs.Root>
    </AppDialog>
  );
}
