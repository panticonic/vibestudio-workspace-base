/**
 * New Panel Page - Shell panel for launching panels from workspace.
 * Opens with Cmd/Ctrl+T and displays available panels with a chat prompt input.
 */
import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { Card, Flex, Heading, Text, Box, Button, TextField, Spinner } from "@radix-ui/themes";
import {
  PlusIcon,
  MagnifyingGlassIcon,
  ChatBubbleIcon,
  PaperPlaneIcon,
  ChevronRightIcon,
  GlobeIcon,
} from "@radix-ui/react-icons";
import { buildPanelLink, panel, workspace } from "@workspace/runtime";
import { useIsMobile } from "@workspace/react/responsive";
import { AboutThemeRoot, AboutPage, Section } from "@workspace/about-shared/ui";
import {
  collectLaunchablePanelGroups,
  LAUNCHABLE_PANEL_CACHE_KEY,
  parseCachedLaunchablePanelGroups,
  serializeLaunchablePanelGroups,
  type LaunchablePanel,
  type LaunchablePanelGroups,
} from "./launchablePanels";
import { browserUrlFromEntry } from "./entryIntent";

interface NavigationTarget {
  source: string;
  href?: string;
}

function readCachedPanelGroups(): LaunchablePanelGroups | null {
  try {
    return parseCachedLaunchablePanelGroups(
      window.localStorage.getItem(LAUNCHABLE_PANEL_CACHE_KEY)
    );
  } catch {
    return null;
  }
}

function cachePanelGroups(groups: LaunchablePanelGroups): void {
  try {
    window.localStorage.setItem(LAUNCHABLE_PANEL_CACHE_KEY, serializeLaunchablePanelGroups(groups));
  } catch {
    // Storage is an optimization; the authoritative source-tree read still works without it.
  }
}

function PanelCard({
  node,
  pending,
  disabled,
  onActivate,
}: {
  node: LaunchablePanel;
  pending: boolean;
  disabled: boolean;
  onActivate: (path: string, href: string) => void;
}) {
  const isMobile = useIsMobile();
  const href = buildPanelLink(node.path);
  return (
    <Card asChild>
      <a
        href={href}
        aria-busy={pending || undefined}
        aria-disabled={disabled || undefined}
        onClick={(event) => {
          if (
            event.defaultPrevented ||
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey
          ) {
            return;
          }
          event.preventDefault();
          if (!disabled) onActivate(node.path, href);
        }}
        style={{
          textDecoration: "none",
          color: "inherit",
          pointerEvents: disabled ? "none" : undefined,
          opacity: disabled && !pending ? 0.55 : 1,
        }}
      >
        <Flex align="center" justify="between" gap="3">
          <Flex
            align={isMobile ? "start" : "center"}
            direction={isMobile ? "column" : "row"}
            gap={isMobile ? "0" : "3"}
            style={{ minWidth: 0 }}
          >
            <Text weight="medium" size="2">
              {node.title}
            </Text>
            <Text size="1" color="gray">
              {node.description ?? `Open ${node.title}`}
            </Text>
          </Flex>
          {pending ? (
            <Spinner style={{ flexShrink: 0 }} />
          ) : (
            <ChevronRightIcon style={{ flexShrink: 0, color: "var(--gray-8)" }} />
          )}
        </Flex>
      </a>
    </Card>
  );
}

function NewPanelPage() {
  const isMobile = useIsMobile();
  const [panelGroups, setPanelGroups] = useState<LaunchablePanelGroups | null>(
    readCachedPanelGroups
  );
  const [loading, setLoading] = useState(panelGroups === null);
  const [error, setError] = useState<string | null>(null);
  const [promptInput, setPromptInput] = useState("");
  const [filter, setFilter] = useState("");
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const fetchInFlightRef = useRef<Promise<void> | null>(null);
  const hasPanelGroupsRef = useRef(panelGroups !== null);
  const lastFetchStartedAtRef = useRef(0);
  const navigationStartedRef = useRef(false);
  const lastNavigationRef = useRef<NavigationTarget | null>(null);

  const fetchData = useCallback((): Promise<void> => {
    if (fetchInFlightRef.current) return fetchInFlightRef.current;

    lastFetchStartedAtRef.current = Date.now();
    if (!hasPanelGroupsRef.current) setLoading(true);
    const request = (async () => {
      try {
        const groups = collectLaunchablePanelGroups((await workspace.sourceTree()).children);
        hasPanelGroupsRef.current = true;
        setPanelGroups(groups);
        cachePanelGroups(groups);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    })();
    fetchInFlightRef.current = request;
    void request.finally(() => {
      if (fetchInFlightRef.current === request) fetchInFlightRef.current = null;
    });
    return request;
  }, []);

  useEffect(() => {
    void fetchData();
    const offFocus = panel.onFocus(() => {
      // Initial focus commonly arrives while the mount request is still in
      // flight. Revalidate genuinely returning launchers, but do not issue the
      // same source-tree RPC twice during startup.
      if (Date.now() - lastFetchStartedAtRef.current > 2_000) void fetchData();
    });
    const offNavigationError = panel.onChildCreationError(({ url, error }) => {
      const target = lastNavigationRef.current;
      if (!target?.href || !url.includes(`/${target.source}/`)) return;
      navigationStartedRef.current = false;
      setPendingPath(null);
      setNavigationError(error);
    });
    return () => {
      offFocus();
      offNavigationError();
    };
  }, [fetchData]);

  const beginNavigation = useCallback((target: NavigationTarget) => {
    if (navigationStartedRef.current) return;
    navigationStartedRef.current = true;
    lastNavigationRef.current = target;
    setPendingPath(target.source);
    setNavigationError(null);
    if (target.href) {
      // Keep anchor hrefs for normal browser affordances, but let the trusted
      // host translate the managed URL into a panel navigation.
      requestAnimationFrame(() => window.location.assign(target.href!));
      return;
    }

    void panel.reopen({ source: target.source }).catch((error: unknown) => {
      navigationStartedRef.current = false;
      setPendingPath(null);
      setNavigationError(error instanceof Error ? error.message : String(error));
    });
  }, []);

  const browserUrl = useMemo(() => browserUrlFromEntry(promptInput), [promptInput]);

  const handleEntry = useCallback(() => {
    const entry = promptInput.trim();
    if (!entry || pendingPath) return;
    if (browserUrl) {
      beginNavigation({ source: browserUrl });
      return;
    }
    beginNavigation({
      source: "panels/chat",
      href: buildPanelLink("panels/chat", { stateArgs: { initialPrompt: entry } }),
    });
  }, [beginNavigation, browserUrl, pendingPath, promptInput]);

  const filteredPanelGroups = useMemo(() => {
    if (!panelGroups) return { panels: [], about: [] };
    const query = filter.trim().toLowerCase();
    if (!query) return panelGroups;
    const matches = (node: LaunchablePanel) =>
      node.path.toLowerCase().includes(query) || node.title.toLowerCase().includes(query);
    return {
      panels: panelGroups.panels.filter(matches),
      about: panelGroups.about.filter(matches),
    };
  }, [panelGroups, filter]);

  const filteredPanels = [...filteredPanelGroups.panels, ...filteredPanelGroups.about];
  const panelCount = (panelGroups?.panels.length ?? 0) + (panelGroups?.about.length ?? 0);

  return (
    <AboutPage icon={<PlusIcon width={20} height={20} />} title="New Panel" maxWidth={640}>
      {/* Chat or browser hero */}
      <Section>
        <Flex align="center" gap="2" mb="3">
          {browserUrl ? (
            <GlobeIcon style={{ color: "var(--accent-9)" }} />
          ) : (
            <ChatBubbleIcon style={{ color: "var(--accent-9)" }} />
          )}
          <Heading size="3">Chat or browse</Heading>
        </Flex>
        <Text as="p" size="2" color="gray" mb="3">
          Enter a web address, such as example.com, to open it directly in a browser panel. Anything
          else starts a new chat.
        </Text>
        <Flex gap="2" direction={isMobile ? "column" : "row"}>
          <TextField.Root
            autoFocus
            aria-label="Chat request or web address"
            size="3"
            style={{ flex: 1 }}
            placeholder="Ask anything or enter a web address..."
            value={promptInput}
            onChange={(e) => setPromptInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleEntry()}
          />
          <Button size="3" onClick={handleEntry} disabled={!promptInput.trim() || !!pendingPath}>
            {pendingPath ? <Spinner /> : browserUrl ? <GlobeIcon /> : <PaperPlaneIcon />}{" "}
            {browserUrl ? "Open site" : "Chat"}
          </Button>
        </Flex>
      </Section>

      {/* Panel list */}
      {loading && !panelGroups ? (
        <Flex align="center" justify="center" gap="2" py="6">
          <Spinner />
          <Text color="gray">Loading panels...</Text>
        </Flex>
      ) : error && !panelGroups ? (
        <Section>
          <Flex direction="column" gap="3" align="start">
            <Text color="red" size="2">
              Failed to load workspace panels: {error}
            </Text>
            <Button variant="soft" onClick={() => void fetchData()}>
              Retry
            </Button>
          </Flex>
        </Section>
      ) : (
        <Box>
          {error ? (
            <Section>
              <Flex direction="column" gap="2" align="start">
                <Text color="orange" size="2">
                  Showing the saved panel list because refreshing it failed: {error}
                </Text>
                <Button variant="soft" onClick={() => void fetchData()}>
                  Refresh
                </Button>
              </Flex>
            </Section>
          ) : null}
          {navigationError ? (
            <Section>
              <Flex direction="column" gap="2" align="start">
                <Text color="red" size="2">
                  Couldn&apos;t open the panel: {navigationError}
                </Text>
                <Button
                  variant="soft"
                  color="red"
                  onClick={() => {
                    const target = lastNavigationRef.current;
                    if (target) beginNavigation(target);
                  }}
                >
                  Try again
                </Button>
              </Flex>
            </Section>
          ) : null}
          <Flex align="center" justify="between" gap="3" mb="3">
            <Heading size="3">Panels</Heading>
            <TextField.Root
              size="2"
              style={{ width: isMobile ? "50%" : 220 }}
              placeholder="Filter..."
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && filteredPanels[0]) {
                  e.preventDefault();
                  const first = filteredPanels[0];
                  beginNavigation({ source: first.path, href: buildPanelLink(first.path) });
                }
              }}
              aria-label="Filter panels; press Enter to open the first result"
            >
              <TextField.Slot>
                <MagnifyingGlassIcon />
              </TextField.Slot>
            </TextField.Root>
          </Flex>

          {filteredPanels.length > 0 ? (
            <Flex direction="column" gap="5">
              {filteredPanelGroups.panels.length > 0 ? (
                <Flex direction="column" gap="2">
                  {filteredPanelGroups.panels.map((node) => (
                    <PanelCard
                      key={node.path}
                      node={node}
                      pending={pendingPath === node.path}
                      disabled={pendingPath !== null}
                      onActivate={(source, targetHref) =>
                        beginNavigation({ source, href: targetHref })
                      }
                    />
                  ))}
                </Flex>
              ) : null}
              {filteredPanelGroups.about.length > 0 ? (
                <Box>
                  <Heading size="3" mb="3">
                    About
                  </Heading>
                  <Flex direction="column" gap="2">
                    {filteredPanelGroups.about.map((node) => (
                      <PanelCard
                        key={node.path}
                        node={node}
                        pending={pendingPath === node.path}
                        disabled={pendingPath !== null}
                        onActivate={(source, targetHref) =>
                          beginNavigation({ source, href: targetHref })
                        }
                      />
                    ))}
                  </Flex>
                </Box>
              ) : null}
            </Flex>
          ) : (
            <Text color="gray" size="2">
              {panelCount === 0 ? "No panels found in workspace" : `No panels match "${filter}"`}
            </Text>
          )}
        </Box>
      )}
    </AboutPage>
  );
}

export default function AboutPanelRoot() {
  return (
    <AboutThemeRoot>
      <NewPanelPage />
    </AboutThemeRoot>
  );
}
