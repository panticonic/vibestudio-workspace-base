import { useApprovalPresentation } from "./ApprovalPresentationContext";
import { APPROVAL_OVERLAY_HOST_ID } from "./ConsentApprovalBar";
import { WorkspaceIconsContext } from "../shell/workspaceIconsContext";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  createStore,
  Provider as StoreProvider,
  useAtomValue,
  useSetAtom,
  useStore,
} from "jotai";
import { Button, Callout, Flex, Text } from "@radix-ui/themes";
import { GearIcon, ReloadIcon } from "@radix-ui/react-icons";
import type { HubWorkspaceEntry } from "@vibestudio/service-schemas/hubControl";
import {
  app,
  createWorkspaceShellClient,
  hubControl,
  systemWorkspaceId,
  incomingPanelLocation,
  incomingShellSurface,
} from "../shell/client";
import {
  ShellWorkspaceClientContext,
  WorkspaceNavigationHostContext,
  WorkspaceVisibilityContext,
  ShellPresentationStoreContext,
} from "../shell/workspaceContext";
import { useDirectShellEvent } from "../shell/useDirectShellEvent";
import {
  settingsDialogAtom,
  workspaceChooserDialogOpenAtom,
} from "../state/appModeAtoms";
import { themeConfigAtom, themeModeAtom } from "../state/themeAtoms";
import { workspaceLabel } from "../shell/workspaceLabel";
import { WorkspaceStack, type WorkspaceSection } from "./WorkspaceStack";
import { PanelApp } from "./PanelApp";
import { ConnectionStatusBadge } from "./ConnectionStatusBadge";
import { ThemeSettings } from "./ThemeSettings";
import "./workspaceDesktop.css";

import type { PanelLocation } from "@vibestudio/shared/panelLocation";

type ClientOwner = Awaited<ReturnType<typeof createWorkspaceShellClient>>;
type OpenWorkspace = ClientOwner & {
  workspace: HubWorkspaceEntry;
  store: ReturnType<typeof createStore>;
};

/** System owns this window. Each retained child owns its store, clients, tree and drafts. */
export function WorkspaceDesktop() {
  const presentationStore = useStore();
  const approvalPresentation = useApprovalPresentation();
  const [catalog, setCatalog] = useState<HubWorkspaceEntry[]>([]);
  const [opened, setOpened] = useState<OpenWorkspace[]>([]);
  const epoch = useRef(0);
  const focusGeneration = useRef(0);
  const owners = useRef(new Map<string, OpenWorkspace>());
  const accessibleIds = useRef<Set<string> | null>(null);
  const openings = useRef(new Map<string, Promise<OpenWorkspace>>());
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const focusedRef = useRef(focusedId);
  focusedRef.current = focusedId;
  const catalogRef = useRef(catalog);
  catalogRef.current = catalog;
  const [expanded, setExpanded] = useState(new Set<string>());
  const [busy, setBusy] = useState(new Set<string>());
  const [error, setError] = useState<string | null>(null);
  const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null);
  const [titleBarHost, setTitleBarHost] = useState<HTMLElement | null>(null);
  const [notificationHost, setNotificationHost] = useState<HTMLElement | null>(
    null,
  );
  const [treeHosts, setTreeHosts] = useState(new Map<string, HTMLElement>());
  const treeRefs = useRef(
    new Map<string, (element: HTMLDivElement | null) => void>(),
  );
  const setSettings = useSetAtom(settingsDialogAtom);
  const setChooser = useSetAtom(workspaceChooserDialogOpenAtom);
  // Appearance and theme identity are one app-wide choice, but each retained
  // workspace renders in its own Jotai store, and the control that sets them
  // (ThemeSettings, in this chrome) writes only to the window's store. Without
  // this mirror the chrome re-themes while every workspace keeps whatever it
  // read from localStorage at mount — and since it is the workspace's
  // PanelStack that broadcasts appearance to the panel views, the panels stop
  // following the setting altogether.
  const themeMode = useAtomValue(themeModeAtom);
  const themeConfig = useAtomValue(themeConfigAtom);
  useEffect(() => {
    for (const owner of opened) {
      // The plain atoms, not their setters: this mirrors a choice that is
      // already persisted, and re-persisting it per workspace would be a write
      // amplification with no reader.
      owner.store.set(themeModeAtom, themeMode);
      owner.store.set(themeConfigAtom, themeConfig);
    }
  }, [opened, themeMode, themeConfig]);
  useEffect(() => {
    approvalPresentation.setHost(notificationHost);
    approvalPresentation.setAnchorId(
      focusedId ? `${APPROVAL_OVERLAY_HOST_ID}:${focusedId}` : null,
    );
  }, [
    notificationHost,
    focusedId,
    approvalPresentation.setHost,
    approvalPresentation.setAnchorId,
  ]);
  const [disconnected, setDisconnected] = useState(new Set<string>());
  const incomingSurfaceDrained = useRef(false);
  useEffect(() => {
    const owner = focusedId ? owners.current.get(focusedId) : undefined;
    if (!owner || incomingSurfaceDrained.current) return;
    incomingSurfaceDrained.current = true;
    // Capture the destination when startup presents its first workspace. A
    // delayed native read must not retarget the link after the user switches.
    void incomingShellSurface
      .getPending()
      .then(async (target) => {
        if (!target) return;
        if (owners.current.get(owner.workspace.workspaceId) !== owner)
          throw new Error("The workspace for that link is no longer available");
        await owner.client.app.openShellSurface(target);
      })
      .catch((error: unknown) => {
        setError(error instanceof Error ? error.message : String(error));
      });
  }, [focusedId]);

  const open = useCallback(
    (workspace: HubWorkspaceEntry): Promise<OpenWorkspace> => {
      const existing = owners.current.get(workspace.workspaceId);
      if (existing) return Promise.resolve(existing);
      const pending = openings.current.get(workspace.workspaceId);
      if (pending) return pending;
      const generation = epoch.current;
      setBusy((ids) => new Set(ids).add(workspace.workspaceId));
      const operation = createWorkspaceShellClient(workspace.workspaceId)
        .then((owner) => {
          if (
            generation !== epoch.current ||
            (accessibleIds.current &&
              !accessibleIds.current.has(workspace.workspaceId))
          ) {
            owner.close();
            throw new Error(
              "Workspace presentation closed or access was removed",
            );
          }
          const opened = { ...owner, workspace, store: createStore() };
          owners.current.set(workspace.workspaceId, opened);
          setOpened([...owners.current.values()]);
          setExpanded((ids) => new Set(ids).add(workspace.workspaceId));
          return opened;
        })
        .finally(() => {
          if (generation !== epoch.current) return;
          openings.current.delete(workspace.workspaceId);
          setBusy((ids) => {
            const next = new Set(ids);
            next.delete(workspace.workspaceId);
            return next;
          });
        });
      openings.current.set(workspace.workspaceId, operation);
      return operation;
    },
    [],
  );

  const select = useCallback(
    async (id: string) => {
      const workspace = catalog.find((entry) => entry.workspaceId === id);
      if (!workspace) return;
      const generation = ++focusGeneration.current;
      try {
        await open(workspace);
        if (generation !== focusGeneration.current) return;
        await hubControl.routeWorkspace({ workspaceId: id });
        if (generation !== focusGeneration.current) return;
        setFocusedId(id);
        setError(null);
      } catch (error) {
        setError(error instanceof Error ? error.message : String(error));
      }
    },
    [catalog, open],
  );

  const refresh = useCallback(
    async (focusWorkspaceId?: string) => {
      const generation = epoch.current;
      const focusAtStart = focusGeneration.current;
      try {
        const pair = await hubControl.ensureUserWorkspaces();
        const sourceId = await systemWorkspaceId;
        if (sourceId !== pair.system.workspaceId)
          throw new Error("Desktop chrome must run from your System workspace");
        const entries = await hubControl.listWorkspaces();
        if (!focusedRef.current && !focusWorkspaceId) {
          focusWorkspaceId = (await app.getInfo()).initialFocusedWorkspaceId;
        }
        if (generation !== epoch.current) return;
        setCatalog(entries);
        const visible = new Set(entries.map((entry) => entry.workspaceId));
        accessibleIds.current = visible;
        for (const [id, owner] of owners.current) {
          if (!visible.has(id)) {
            owner.close();
            owners.current.delete(id);
          }
        }
        setOpened([...owners.current.values()]);
        await Promise.all([
          open(pair.personal),
          open(pair.system),
          ...entries
            .filter((entry) => entry.pendingApprovalCount > 0)
            .map(open),
        ]);
        if (focusWorkspaceId) {
          const target = entries.find(
            (entry) => entry.workspaceId === focusWorkspaceId,
          );
          if (target) await open(target);
        }
        // Initial loading must not replace a workspace explicitly selected while
        // its private owners were opening.
        if (
          generation !== epoch.current ||
          focusAtStart !== focusGeneration.current
        )
          return;
        if (!owners.current.has(focusedRef.current ?? ""))
          await hubControl.routeWorkspace({
            workspaceId:
              focusWorkspaceId && visible.has(focusWorkspaceId)
                ? focusWorkspaceId
                : pair.personal.workspaceId,
          });
        if (
          generation !== epoch.current ||
          focusAtStart !== focusGeneration.current
        )
          return;
        setFocusedId((current) =>
          focusWorkspaceId && visible.has(focusWorkspaceId)
            ? focusWorkspaceId
            : current && visible.has(current)
              ? current
              : pair.personal.workspaceId,
        );
        setError(null);
      } catch (error) {
        if (generation !== epoch.current) return;
        setError(error instanceof Error ? error.message : String(error));
      }
    },
    [open],
  );
  useEffect(() => {
    void refresh();
    const onFocus = () => {
      void refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);
  useEffect(
    () => () => {
      epoch.current += 1;
      openings.current.clear();
      for (const owner of owners.current.values()) owner.close();
      owners.current.clear();
    },
    [],
  );
  useDirectShellEvent(
    "workspace-focused",
    useCallback(
      ({ workspaceId }) => {
        if (owners.current.has(workspaceId)) setFocusedId(workspaceId);
        else void refresh(workspaceId);
      },
      [refresh],
    ),
  );

  useEffect(() => {
    let live = true;
    const handle = async (location: PanelLocation) => {
      try {
        const entries = catalogRef.current.length
          ? catalogRef.current
          : await hubControl.listWorkspaces();
        const target = location.workspace
          ? entries.find((entry) => entry.name === location.workspace)
          : (entries.find(
              (entry) => entry.workspaceId === focusedRef.current,
            ) ?? entries.find((entry) => entry.privateRole === "personal"));
        if (!target)
          throw new Error("The workspace for this panel link is unavailable");
        const owner = await open(target);
        if (!live) return;
        await hubControl.routeWorkspace({ workspaceId: target.workspaceId });
        setFocusedId(target.workspaceId);
        const panel = owner.client.panel;
        const focusedPanelId = await panel.getFocusedPanelId();
        const common = {
          ref: location.ref,
          contextId: location.contextId,
          stateArgs: location.stateArgs,
          placement: location.placement,
        };
        if (location.disposition === "current" && focusedPanelId)
          await panel.navigate(focusedPanelId, location.source, common);
        else if (location.disposition === "child" && focusedPanelId)
          await panel.createChild(focusedPanelId, location.source, {
            ...common,
            title: location.title,
            slug: location.slug,
            focus: location.focus ?? true,
          });
        else
          await panel.createPanel(location.source, {
            ...common,
            title: location.title,
            slug: location.slug,
            isRoot: true,
            focus: location.focus ?? true,
          });
      } catch (error) {
        if (live)
          setError(error instanceof Error ? error.message : String(error));
      }
    };
    const release = incomingPanelLocation.onLocation((location) => {
      void handle(location);
    });
    void incomingPanelLocation.getPending().then((location) => {
      if (live && location) void handle(location);
    });
    return () => {
      release();
    };
  }, [open]);

  const createPanel = async (id: string) => {
    const workspace = catalog.find((entry) => entry.workspaceId === id);
    if (!workspace) return;
    try {
      const owner = await open(workspace);
      await owner.client.panel.createAboutPanel("new");
      await select(id);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };
  const refFor = (id: string) => {
    let callback = treeRefs.current.get(id);
    if (!callback) {
      callback = (element) =>
        setTreeHosts((hosts) => {
          if (hosts.get(id) === element || (!element && !hosts.has(id)))
            return hosts;
          const next = new Map(hosts);
          if (element) next.set(id, element);
          else next.delete(id);
          return next;
        });
      treeRefs.current.set(id, callback);
    }
    return callback;
  };
  const reviewApprovals = (id: string) => {
    setChooser(false);
    approvalPresentation.request(id);
    const workspace = catalog.find((entry) => entry.workspaceId === id);
    if (workspace)
      void open(workspace).catch((error) => setError(String(error)));
  };
  const sections: WorkspaceSection[] = catalog.map((workspace) => ({
    workspace,
    state: busy.has(workspace.workspaceId)
      ? "opening"
      : owners.current.has(workspace.workspaceId)
        ? disconnected.has(workspace.workspaceId)
          ? "disconnected"
          : "ready"
        : "closed",
    expanded: expanded.has(workspace.workspaceId),
    focused: workspace.workspaceId === focusedId,
    approvalCount: owners.current.has(workspace.workspaceId)
      ? approvalPresentation.entries.filter(
          (entry) =>
            entry.workspaceId === workspace.workspaceId && entry.actionable,
        ).length
      : workspace.pendingApprovalCount,
    tree: (
      <div
        className="workspace-tree-host"
        ref={refFor(workspace.workspaceId)}
      />
    ),
  }));

  return (
    <ShellPresentationStoreContext.Provider value={presentationStore}>
      <div className="workspace-desktop">
        <header className="workspace-desktop-titlebar" ref={setTitleBarHost} />
        <div className="workspace-desktop-body">
          <aside
            className="workspace-desktop-navigation"
            hidden={!sidebarVisible}
          >
            <WorkspaceStack
              scrollRef={setScrollElement}
              sections={sections}
              onToggleExpanded={(id) => {
                if (!owners.current.has(id)) {
                  void select(id);
                  return;
                }
                setExpanded((ids) => {
                  const next = new Set(ids);
                  if (!next.delete(id)) next.add(id);
                  return next;
                });
              }}
              onOpenWorkspace={(id) => {
                void select(id);
              }}
              onCreatePanel={(id) => {
                void createPanel(id);
              }}
              onReviewApprovals={reviewApprovals}
              onAddWorkspace={() => setChooser(true)}
            />
            <Flex className="workspace-desktop-controls" gap="2" align="center">
              <Button
                variant="ghost"
                color="gray"
                onClick={() =>
                  setSettings({
                    section: "workspaces",
                    ...(focusedId ? { workspaceId: focusedId } : {}),
                  })
                }
              >
                <GearIcon /> Settings
              </Button>
              <ConnectionStatusBadge
                onOpenSettings={() => setSettings({ section: "connection" })}
              />
              <ThemeSettings />
            </Flex>
          </aside>
          <main className="workspace-desktop-content">
            {error && (
              <Callout.Root color="red">
                <Callout.Text>{error}</Callout.Text>
                <Button variant="soft" onClick={() => void refresh()}>
                  <ReloadIcon /> Try again
                </Button>
              </Callout.Root>
            )}
            {!focusedId && !error && (
              <Text className="workspace-desktop-starting" color="gray">
                Opening your workspaces…
              </Text>
            )}
            {opened.map((owner) => (
              <StoreProvider
                key={owner.workspace.workspaceId}
                store={owner.store}
              >
                <WorkspaceIconsContext.Provider value={owner.client.unitIcons}>
                  <ShellWorkspaceClientContext.Provider value={owner.client}>
                    <WorkspaceVisibilityContext.Provider
                      value={owner.workspace.workspaceId === focusedId}
                    >
                      <WorkspaceNavigationHostContext.Provider
                        value={{
                          scrollElement,
                          titleBarHost,
                          notificationHost,
                          setNotificationHost,
                          element:
                            treeHosts.get(owner.workspace.workspaceId) ?? null,
                          workspaceId: owner.workspace.workspaceId,
                          privateRole: owner.workspace.privateRole,
                          workspaceLabel: workspaceLabel(owner.workspace),
                          workspaceNames: Object.fromEntries(
                            catalog.map((entry) => [
                              entry.workspaceId,
                              workspaceLabel(entry),
                            ]),
                          ),
                          sidebarVisible,
                          toggleSidebar: () =>
                            setSidebarVisible((visible) => !visible),
                          focus: () => {
                            void select(owner.workspace.workspaceId);
                          },
                        }}
                      >
                        <WorkspacePanelOwner
                          owner={owner}
                          visible={owner.workspace.workspaceId === focusedId}
                          onConnection={(connected) =>
                            setDisconnected((current) => {
                              const id = owner.workspace.workspaceId;
                              if (current.has(id) === !connected)
                                return current;
                              const next = new Set(current);
                              if (connected) next.delete(id);
                              else next.add(id);
                              return next;
                            })
                          }
                        />
                      </WorkspaceNavigationHostContext.Provider>
                    </WorkspaceVisibilityContext.Provider>
                  </ShellWorkspaceClientContext.Provider>
                </WorkspaceIconsContext.Provider>
              </StoreProvider>
            ))}
          </main>
        </div>
      </div>
    </ShellPresentationStoreContext.Provider>
  );
}

function WorkspacePanelOwner({
  owner,
  visible,
  onConnection,
}: {
  owner: OpenWorkspace;
  visible: boolean;
  onConnection(connected: boolean): void;
}) {
  const connection = useRef(onConnection);
  connection.current = onConnection;
  useEffect(() => {
    const releaseStatus = owner.client.events.on(
      "server-connection-changed",
      (event) => connection.current(event.status === "connected"),
    );
    void owner.client.events.subscribe("server-connection-changed");
    return () => {
      releaseStatus();
      void owner.client.events.unsubscribe("server-connection-changed");
    };
  }, [owner]);
  return (
    <div className="workspace-desktop-runtime" hidden={!visible}>
      <PanelApp />
    </div>
  );
}
