import { WorkspaceMembersSection } from "./WorkspaceMembersSection";
import { useShellWorkspaceClient } from "../shell/workspaceContext";
import { workspaceLabel } from "../shell/workspaceLabel";
import { useCallback, useEffect, useState } from "react";
import {
  ArrowRightIcon,
  CheckCircledIcon,
  LockClosedIcon,
  MixerHorizontalIcon,
  PlusIcon,
  TrashIcon,
} from "@radix-ui/react-icons";
import {
  Badge,
  Box,
  Button,
  Callout,
  Flex,
  Select,
  Spinner,
  Text,
  TextField,
} from "@radix-ui/themes";
import type { HubWorkspaceEntry } from "@vibestudio/service-schemas/hubControl";
import type {
  WorkspaceRpcPolicy,
  WorkspaceRpcScope,
} from "@vibestudio/identity/workspaceRpcPolicy";
import { type hubControl } from "../shell/client";
import "./workspaceConnections.css";

type PolicySnapshot = Awaited<
  ReturnType<typeof hubControl.getWorkspaceRpcPolicy>
>;
type Direction = "incoming" | "outgoing";

/** Host policy is the source of truth; this surface stores no connection records. */
export function WorkspaceConnectionsSection({
  initialWorkspaceId,
}: {
  initialWorkspaceId?: string;
}) {
  const { account, hubControl } = useShellWorkspaceClient();

  const [management, setManagement] = useState(new Map<string, boolean>());
  const onAccess = useCallback((id: string, allowed: boolean) => {
    setManagement((current) =>
      current.get(id) === allowed ? current : new Map(current).set(id, allowed),
    );
  }, []);
  const [workspaces, setWorkspaces] = useState<HubWorkspaceEntry[]>([]);
  const [selectedId, setSelectedId] = useState(initialWorkspaceId ?? "");
  const [userId, setUserId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    Promise.all([hubControl.listWorkspaces(), account.getProfile()])
      .then(([rows, profile]) => {
        if (!active) return;
        setWorkspaces(rows);
        setUserId(profile?.userId ?? "");
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setError(error instanceof Error ? error.message : String(error));
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  const selected = workspaces.find((row) => row.workspaceId === selectedId);
  return (
    <Flex direction="column" gap="4" className="workspace-connections">
      <Flex align="start" gap="3">
        <span className="workspace-connections-icon">
          <MixerHorizontalIcon width="21" height="21" />
        </span>
        <Box>
          <Text as="div" size="4" weight="bold">
            Make room for useful connections
          </Text>
          <Text as="p" size="2" color="gray" mt="1">
            Choose which operations may ask for access between workspaces. Your
            files and tools still have their own approvals.
          </Text>
        </Box>
      </Flex>
      {loading ? (
        <Flex align="center" gap="2" role="status">
          <Spinner />
          <Text size="2">Loading your workspaces…</Text>
        </Flex>
      ) : null}
      {error ? (
        <Callout.Root color="red" role="alert">
          <Callout.Text>{error}</Callout.Text>
        </Callout.Root>
      ) : null}
      {!loading && !error ? (
        <Flex direction="column" gap="2">
          <Text
            as="label"
            htmlFor="connection-workspace"
            size="2"
            weight="medium"
          >
            Managing workspace
          </Text>
          <Select.Root value={selectedId} onValueChange={setSelectedId}>
            <Select.Trigger
              id="connection-workspace"
              placeholder="Choose a workspace"
            />
            <Select.Content>
              {workspaces.map((row) => (
                <Select.Item key={row.workspaceId} value={row.workspaceId}>
                  {workspaceLabel(row)}
                  {row.privateRole ? " · Only you" : ""}
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
        </Flex>
      ) : null}
      {selected ? (
        <>
          {selected.privateRole || management.get(selected.workspaceId) ? (
            <WorkspacePolicyEditor
              key={selected.workspaceId}
              workspace={selected}
              workspaces={workspaces}
              userId={userId}
            />
          ) : management.get(selected.workspaceId) === false ? (
            <Text size="2" color="gray">
              A workspace admin manages connection rules for this workspace.
            </Text>
          ) : null}
          <WorkspaceMembersSection
            key={`members:${selected.workspaceId}`}
            workspace={selected}
            userId={userId}
            onAccess={onAccess}
          />
        </>
      ) : !loading && !error ? (
        <div className="workspace-connections-empty">
          <LockClosedIcon width="24" height="24" />
          <Text as="p" size="2" color="gray">
            Workspaces keep their own boundaries.
            <br />
            Choose one above to see its incoming and outgoing permissions.
          </Text>
        </div>
      ) : null}
    </Flex>
  );
}

function WorkspacePolicyEditor({
  workspace,
  workspaces,
  userId,
}: {
  workspace: HubWorkspaceEntry;
  workspaces: HubWorkspaceEntry[];
  userId: string;
}) {
  const { hubControl } = useShellWorkspaceClient();

  const [snapshot, setSnapshot] = useState<PolicySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Direction | null>(null);
  const [review, setReview] = useState<{
    direction: Direction;
    scope: WorkspaceRpcScope;
    removing: boolean;
  } | null>(null);
  const load = async () => {
    setError(null);
    const next = await hubControl.getWorkspaceRpcPolicy({
      workspaceId: workspace.workspaceId,
    });
    setSnapshot(next);
  };
  useEffect(() => {
    let active = true;
    hubControl
      .getWorkspaceRpcPolicy({ workspaceId: workspace.workspaceId })
      .then((next) => {
        if (active) setSnapshot(next);
      })
      .catch((error: unknown) => {
        if (active)
          setError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      active = false;
    };
  }, [workspace.workspaceId]);
  const save = async () => {
    if (!snapshot || !review || busy) return;
    // Capture the exact target and version being reviewed. Focus and chooser
    // changes cannot move this operation to a different workspace.
    const { direction, scope, removing } = review;
    const scopes = snapshot.policy[direction];
    const key = (value: WorkspaceRpcScope) =>
      JSON.stringify([
        value.workspaceId,
        value.userId,
        value.target,
        value.operation,
        value.purpose,
      ]);
    const policy: WorkspaceRpcPolicy = {
      ...snapshot.policy,
      [direction]: removing
        ? scopes.filter((value) => key(value) !== key(scope))
        : [...scopes, scope],
    };
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const next = await hubControl.setWorkspaceRpcPolicy({
        workspaceId: workspace.workspaceId,
        policy,
        expectedPolicy: snapshot.policy,
      });
      setSnapshot(next);
      setReview(null);
      setEditing(null);
      setNotice(
        removing
          ? "Permission removed."
          : "Permission saved. Resource approval is still required.",
      );
    } catch (error: unknown) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const peerName = (id: string) =>
    (() => {
      const entry = workspaces.find((entry) => entry.workspaceId === id);
      return entry ? workspaceLabel(entry) : id;
    })();
  return (
    <Flex direction="column" gap="4">
      {error ? (
        <Callout.Root color="red" role="alert">
          <Callout.Text>{error}</Callout.Text>
          <Button
            variant="soft"
            size="1"
            disabled={busy}
            onClick={() =>
              void load().catch((error: unknown) => setError(String(error)))
            }
          >
            Reload settings
          </Button>
        </Callout.Root>
      ) : null}
      {notice ? (
        <Flex gap="2" align="center" role="status">
          <CheckCircledIcon color="var(--green-11)" />
          <Text size="2">{notice}</Text>
        </Flex>
      ) : null}
      {!snapshot && !error ? (
        <Flex gap="2" align="center" role="status">
          <Spinner />
          <Text size="2">Loading {workspaceLabel(workspace)} permissions…</Text>
        </Flex>
      ) : null}
      {snapshot ? (
        <>
          {(["incoming", "outgoing"] as const).map((direction) => {
            const locked = direction === "incoming" && snapshot.incomingLocked;
            const scopes = snapshot.policy[direction];
            return (
              <section
                key={direction}
                className="workspace-policy-direction"
                aria-labelledby={`policy-${direction}`}
              >
                <Flex align="start" justify="between" gap="3">
                  <Box>
                    <Text
                      as="div"
                      id={`policy-${direction}`}
                      size="3"
                      weight="bold"
                    >
                      {direction === "incoming"
                        ? "Incoming calls"
                        : "Outgoing calls"}
                    </Text>
                    <Text as="p" size="2" color="gray" mt="1">
                      {direction === "incoming"
                        ? `Requests started in another workspace and received by ${workspaceLabel(workspace)}.`
                        : `Requests started in ${workspaceLabel(workspace)} and sent to another workspace.`}
                    </Text>
                  </Box>
                  {!locked ? (
                    <Button
                      variant="soft"
                      size="1"
                      disabled={busy || review !== null}
                      onClick={() => {
                        setEditing(direction);
                        setNotice(null);
                      }}
                    >
                      <PlusIcon />
                      Add permission
                    </Button>
                  ) : (
                    <Badge color="gray">
                      <LockClosedIcon />
                      Closed
                    </Badge>
                  )}
                </Flex>
                {locked ? (
                  <div className="workspace-policy-closed">
                    <LockClosedIcon />
                    <Text size="2">
                      System receives no application calls from other
                      workspaces. Replies to calls it starts can still return.
                    </Text>
                  </div>
                ) : scopes.length === 0 ? (
                  <Text as="p" size="2" color="gray" mt="3">
                    No operations can request access in this direction.
                  </Text>
                ) : (
                  <ul className="workspace-policy-scopes">
                    {scopes.map((scope) => (
                      <li key={JSON.stringify(scope)}>
                        <Box style={{ minWidth: 0 }}>
                          <Flex align="center" gap="2" wrap="wrap">
                            <Text size="2" weight="medium">
                              {direction === "incoming"
                                ? peerName(scope.workspaceId)
                                : workspaceLabel(workspace)}
                            </Text>
                            <ArrowRightIcon />
                            <Text size="2" weight="medium">
                              {direction === "incoming"
                                ? workspaceLabel(workspace)
                                : peerName(scope.workspaceId)}
                            </Text>
                            <Badge variant="soft" color="gray">
                              {scope.purpose === "discover"
                                ? "Discover"
                                : "May request access"}
                            </Badge>
                          </Flex>
                          <Text
                            as="div"
                            size="2"
                            mt="1"
                            className="workspace-policy-operation"
                          >
                            {scope.target} · {scope.operation}
                          </Text>
                          <Text as="div" size="1" color="gray" mt="1">
                            For{" "}
                            {scope.userId === userId
                              ? "your account"
                              : scope.userId}
                          </Text>
                        </Box>
                        <Button
                          variant="ghost"
                          color="gray"
                          aria-label={`Remove ${scope.operation} on ${scope.target} permission`}
                          disabled={busy || review !== null}
                          onClick={() =>
                            setReview({ direction, scope, removing: true })
                          }
                        >
                          <TrashIcon />
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
                {editing === direction && !review ? (
                  <PermissionForm
                    direction={direction}
                    workspace={workspace}
                    peers={workspaces.filter(
                      (entry) =>
                        entry.workspaceId !== workspace.workspaceId &&
                        (direction === "incoming" ||
                          entry.privateRole !== "system"),
                    )}
                    userId={userId}
                    onCancel={() => setEditing(null)}
                    onReview={(scope) =>
                      setReview({ direction, scope, removing: false })
                    }
                  />
                ) : null}
              </section>
            );
          })}
          {review ? (
            <div
              className="workspace-policy-review"
              role="region"
              aria-label="Review workspace permission"
            >
              <Text as="div" size="3" weight="bold">
                {review.removing
                  ? "Remove this permission?"
                  : "Review permission"}
              </Text>
              <Text as="p" size="2" mt="2">
                <strong>
                  {review.direction === "incoming"
                    ? peerName(review.scope.workspaceId)
                    : workspaceLabel(workspace)}
                </strong>{" "}
                →{" "}
                <strong>
                  {review.direction === "incoming"
                    ? workspaceLabel(workspace)
                    : peerName(review.scope.workspaceId)}
                </strong>
              </Text>
              <Text as="p" size="2" mt="2">
                {review.removing
                  ? "This operation will no longer be eligible to request access through this rule. Previously copied data stays where it was shared."
                  : "This opens one side of the boundary for your account. The other workspace must also permit the operation, and ordinary approvals still apply."}
              </Text>
              <Text
                as="div"
                size="2"
                mt="2"
                className="workspace-policy-operation"
              >
                {review.scope.purpose === "discover" ? "Discover" : "Call"}:{" "}
                {review.scope.target} · {review.scope.operation}
              </Text>
              <Flex justify="end" gap="2" mt="3">
                <Button
                  variant="soft"
                  color="gray"
                  disabled={busy}
                  onClick={() => setReview(null)}
                >
                  Cancel
                </Button>
                <Button
                  color={review.removing ? "red" : undefined}
                  loading={busy}
                  onClick={() => void save()}
                >
                  {review.removing ? "Remove permission" : "Save permission"}
                </Button>
              </Flex>
            </div>
          ) : null}
        </>
      ) : null}
    </Flex>
  );
}

function PermissionForm({
  direction,
  workspace,
  peers,
  userId,
  onCancel,
  onReview,
}: {
  direction: Direction;
  workspace: HubWorkspaceEntry;
  peers: HubWorkspaceEntry[];
  userId: string;
  onCancel(): void;
  onReview(scope: WorkspaceRpcScope): void;
}) {
  const [peer, setPeer] = useState("");
  const [operation, setOperation] = useState("");
  const [target, setTarget] = useState("");
  const [purpose, setPurpose] = useState<WorkspaceRpcScope["purpose"]>("call");
  return (
    <form
      className="workspace-permission-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (peer && target.trim() && operation.trim() && userId)
          onReview({
            workspaceId: peer,
            userId,
            target: target.trim(),
            operation: operation.trim(),
            purpose,
          });
      }}
    >
      <Text as="div" size="2" weight="medium">
        Allow a specific operation
      </Text>
      <Text as="label" size="2" htmlFor={`peer-${direction}`}>
        {direction === "incoming" ? "From workspace" : "To workspace"}
      </Text>
      <Select.Root value={peer} onValueChange={setPeer}>
        <Select.Trigger
          id={`peer-${direction}`}
          placeholder="Choose a workspace"
        />
        <Select.Content>
          {peers.map((entry) => (
            <Select.Item key={entry.workspaceId} value={entry.workspaceId}>
              {workspaceLabel(entry)}
            </Select.Item>
          ))}
        </Select.Content>
      </Select.Root>
      <Text as="label" size="2" htmlFor={`target-${direction}`}>
        Exact target
      </Text>
      <TextField.Root
        id={`target-${direction}`}
        placeholder="Runtime target or main"
        value={target}
        onChange={(event) => setTarget(event.target.value)}
        required
      />
      <Text as="label" size="2" htmlFor={`operation-${direction}`}>
        Exact method
      </Text>
      <TextField.Root
        id={`operation-${direction}`}
        placeholder="Method supplied by the integration"
        value={operation}
        onChange={(event) => setOperation(event.target.value)}
        required
        aria-describedby={`operation-help-${direction}`}
      />
      <Text id={`operation-help-${direction}`} size="1" color="gray">
        Use the exact target and method supplied by the integration. Wildcards
        are not allowed.
      </Text>
      <Text as="label" size="2" htmlFor={`purpose-${direction}`}>
        Permission
      </Text>
      <Select.Root
        value={purpose}
        onValueChange={(value) =>
          setPurpose(value as WorkspaceRpcScope["purpose"])
        }
      >
        <Select.Trigger id={`purpose-${direction}`} />
        <Select.Content>
          <Select.Item value="call">Request an operation</Select.Item>
          <Select.Item value="discover">
            Discover operation metadata
          </Select.Item>
        </Select.Content>
      </Select.Root>
      <Text size="1" color="gray">
        Applies to your account in {workspaceLabel(workspace)}. Discovery and
        execution are separate permissions.
      </Text>
      <Flex justify="end" gap="2">
        <Button type="button" variant="ghost" color="gray" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="soft"
          disabled={
            !peer ||
            !userId ||
            !target.trim() ||
            target.includes("*") ||
            !operation.trim() ||
            operation.includes("*")
          }
        >
          Review permission
        </Button>
      </Flex>
    </form>
  );
}
