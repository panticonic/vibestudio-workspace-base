import { useEffect, useRef, useState } from "react";
import {
  pendingAuthorityNotice,
  isAuthorityPending,
} from "@vibestudio/shared/authority/reviewPending";
import {
  Badge,
  Box,
  Button,
  Callout,
  Card,
  Flex,
  Grid,
  Heading,
  Text,
  TextField,
} from "@radix-ui/themes";
import type {
  TemplateExactPin,
  TemplateInspection,
  TemplateLocator,
} from "@vibestudio/service-schemas/templates";
import { sameWorkspaceTemplatePin } from "@vibestudio/service-schemas/templates";
import { workspaceExamples } from "@workspace/template-management";
import type { TemplateManagementClient } from "@workspace/template-management";

type BrowserClient = Pick<TemplateManagementClient, "inspect">;
export type CreateTemplateWorkspace = (
  name: string,
  pin: TemplateExactPin,
) => Promise<void>;
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const sourceAddress = (pin: TemplateExactPin) => pin.url.replace(/^git\+/, "");

/** The exact reviewed pin is captured with the name before creating anything. */
export function TemplateWorkspaceReview({
  inspection,
  onCreate,
  onBack,
}: {
  inspection: TemplateInspection;
  onCreate: CreateTemplateWorkspace;
  onBack?: () => void;
}) {
  const [name, setName] = useState(
    () =>
      (inspection.presentation?.name ?? "new-workspace")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "") || "new-workspace",
  );
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const create = async () => {
    if (pending.current || !/^[A-Za-z0-9_-]+$/.test(name.trim())) return;
    pending.current = true;
    setCreating(true);
    setError(null);
    const selectedName = name.trim();
    const selectedPin = { ...inspection.pin };
    try {
      await onCreate(selectedName, selectedPin);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      pending.current = false;
      setCreating(false);
    }
  };
  return (
    <Flex direction="column" gap="4" style={{ minWidth: 0 }}>
      <Box>
        <Badge color="gray" variant="soft">
          New workspace
        </Badge>
        <Heading size="5" mt="2">
          {inspection.presentation?.name ?? "Make this workspace yours"}
        </Heading>
        {inspection.presentation?.description ? (
          <Text as="p" color="gray" size="2" mt="2">
            {inspection.presentation.description}
          </Text>
        ) : null}
      </Box>
      <Card variant="surface">
        <Flex direction="column" gap="2" style={{ minWidth: 0 }}>
          <Text size="2" weight="medium">
            Source you’re opening
          </Text>
          <Text as="div" size="2" style={{ overflowWrap: "anywhere" }}>
            {sourceAddress(inspection.pin)}
          </Text>
          <details>
            <summary
              style={{
                cursor: "pointer",
                minHeight: 44,
                alignContent: "center",
                fontSize: 13,
              }}
            >
              View source details
            </summary>
            <Text
              as="div"
              size="1"
              color="gray"
              style={{ overflowWrap: "anywhere" }}
            >
              {inspection.pin.ref} · {inspection.pin.commit}
            </Text>
            <Text as="div" size="1" style={{ overflowWrap: "anywhere" }}>
              {inspection.pin.snapshot}
            </Text>
            <Text as="div" size="1" mt="2">
              {inspection.repositories.length} source components
            </Text>
            <ul
              style={{
                margin: "8px 0",
                paddingInlineStart: 20,
                maxHeight: 180,
                overflow: "auto",
                overflowWrap: "anywhere",
                fontSize: 12,
              }}
            >
              {inspection.repositories.map((repo) => (
                <li key={repo}>{repo}</li>
              ))}
            </ul>
          </details>
        </Flex>
      </Card>
      <Text as="p" size="2" color="gray">
        This workspace gets its own panels, files and approvals. Connections to
        your other workspaces are yours to choose.
      </Text>
      <label>
        <Text as="div" size="2" weight="medium" mb="2">
          Workspace name
        </Text>
        <TextField.Root
          aria-label="Workspace name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          disabled={creating}
          size="3"
        />
        <Text as="div" size="1" color="gray" mt="1">
          Use letters, numbers, hyphens or underscores.
        </Text>
      </label>
      {error ? (
        <Callout.Root color="red" role="alert">
          <Callout.Text>{error}</Callout.Text>
        </Callout.Root>
      ) : null}
      <Flex gap="3" justify="end">
        {onBack ? (
          <Button
            variant="soft"
            color="gray"
            size="3"
            disabled={creating}
            onClick={onBack}
          >
            Back
          </Button>
        ) : null}
        <Button
          size="3"
          loading={creating}
          disabled={creating || !/^[A-Za-z0-9_-]+$/.test(name.trim())}
          onClick={() => void create()}
        >
          {creating ? "Creating workspace…" : "Create workspace"}
        </Button>
      </Flex>
    </Flex>
  );
}

interface TemplateBrowserProps {
  client: BrowserClient;
  initialPin?: TemplateExactPin;
  initialSourceUrl?: string;
  initialInspection?: TemplateInspection;
  candidates?: readonly TemplateInspection[];
  onReviewPending?: (approvalId: string) => void;
  onCreate?: CreateTemplateWorkspace;
  onChooseFolder?: () => Promise<TemplateInspection | null>;
  onOpenInApp?: (inspection: TemplateInspection) => Promise<void>;
}

/** Each externally selected source owns one review session and its async work. */
export function TemplateBrowser(props: TemplateBrowserProps) {
  return (
    <WorkspaceSourceSession
      key={JSON.stringify(
        props.initialInspection?.pin ??
          props.initialPin ??
          props.initialSourceUrl ??
          null,
      )}
      {...props}
    />
  );
}

function WorkspaceSourceSession({
  client,
  onCreate,
  onOpenInApp,
  initialPin,
  initialSourceUrl,
  initialInspection,
  candidates = [],
  onReviewPending,
  onChooseFolder,
}: TemplateBrowserProps) {
  const [error, setError] = useState<unknown>(null);
  const lastLocator = useRef<TemplateLocator | null>(null);
  const review = pendingAuthorityNotice(error);
  const awaitingReview = isAuthorityPending(error);
  const [url, setUrl] = useState(initialSourceUrl ?? "");
  const [credential, setCredential] = useState("");
  const [currentInspection, setInspection] =
    useState<TemplateInspection | null>(initialInspection ?? null);
  const [inspecting, setInspecting] = useState(false);
  const generation = useRef(0);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      generation.current += 1;
    };
  }, []);
  const inspect = async (locator: TemplateLocator) => {
    lastLocator.current = locator;
    const operation = ++generation.current;
    setInspecting(true);
    setError(null);
    try {
      const result = await client.inspect(locator);
      if (
        "pin" in locator &&
        !sameWorkspaceTemplatePin(result.pin, locator.pin)
      )
        throw new Error(
          "The inspected source does not match the selected workspace. Review the source again.",
        );
      if (live.current && operation === generation.current)
        setInspection(result);
    } catch (error) {
      if (live.current && operation === generation.current) setError(error);
    } finally {
      if (live.current && operation === generation.current)
        setInspecting(false);
    }
  };
  useEffect(() => {
    if (!initialInspection && initialPin) void inspect({ pin: initialPin });
  }, [initialInspection, initialPin, client]);
  if (currentInspection && onCreate)
    return (
      <TemplateWorkspaceReview
        inspection={currentInspection}
        onCreate={onCreate}
        onBack={() => setInspection(null)}
      />
    );
  const canInspect = (() => {
    try {
      return ["https:", "http:"].includes(
        new URL(url.replace(/^git\+/, "")).protocol,
      );
    } catch {
      return false;
    }
  })();
  return (
    <Flex direction="column" gap="5">
      {error ? (
        <Callout.Root
          color={awaitingReview ? "amber" : "red"}
          role={awaitingReview ? "status" : "alert"}
        >
          <Callout.Text>
            {awaitingReview
              ? (review?.message ??
                "A workspace setup review is waiting for you.")
              : errorMessage(error)}
          </Callout.Text>
          {awaitingReview && (
            <Flex direction="column" gap="2">
              {review && onReviewPending ? (
                <Button onClick={() => onReviewPending(review.approvalId)}>
                  {review.kind === "acquisition"
                    ? "Open approval"
                    : "Open review"}
                </Button>
              ) : (
                <Text size="2">
                  Open Approvals to finish this review, then check again.
                </Text>
              )}
              <Button
                variant="soft"
                onClick={() => {
                  if (lastLocator.current) void inspect(lastLocator.current);
                }}
              >
                Check again
              </Button>
            </Flex>
          )}
        </Callout.Root>
      ) : null}
      {currentInspection ? (
        <Card>
          <Heading size="3">
            {currentInspection.presentation?.name ?? "Workspace source"}
          </Heading>
          <Text as="p" size="2" color="gray" mt="2">
            {currentInspection.presentation?.description}
          </Text>
          <Text as="div" size="1" mt="2" style={{ overflowWrap: "anywhere" }}>
            {sourceAddress(currentInspection.pin)} ·{" "}
            {currentInspection.pin.commit.slice(0, 12)}
          </Text>
          {onOpenInApp ? (
            <Button
              size="3"
              mt="3"
              onClick={() =>
                void onOpenInApp(currentInspection).catch((error) =>
                  setError(error),
                )
              }
            >
              Continue in app
            </Button>
          ) : null}
        </Card>
      ) : null}
      {onChooseFolder ? (
        <Flex direction="column" gap="2">
          <Heading size="3">From a folder on this computer</Heading>
          <Text size="2" color="gray">Use a workspace folder, including changes you haven’t committed.</Text>
          <Box>
            <Button size="3" variant="soft" disabled={inspecting} loading={inspecting} onClick={() => {
              const operation = ++generation.current;
              setInspecting(true); setError(null);
              void onChooseFolder().then(result => {
                if (live.current && operation === generation.current && result) setInspection(result);
              }).catch(error => {
                if (live.current && operation === generation.current) setError(error);
              }).finally(() => {
                if (live.current && operation === generation.current) setInspecting(false);
              });
            }}>Choose folder…</Button>
          </Box>
        </Flex>
      ) : null}
      {candidates.length > 0 ? (
        <Flex direction="column" gap="3">
          <Heading size="3">Local workspaces</Heading>
          <Grid columns={{ initial: "1", sm: "2" }} gap="3">
            {candidates.map((candidate) => (
              <Card key={JSON.stringify(candidate.pin)}>
                <Heading size="3">
                  {candidate.presentation?.name ?? "Workspace source"}
                </Heading>
                {candidate.presentation?.description ? (
                  <Text as="p" size="2" color="gray" mt="2">
                    {candidate.presentation.description}
                  </Text>
                ) : null}
                <Button
                  size="3"
                  variant="soft"
                  mt="3"
                  onClick={() => setInspection(candidate)}
                >
                  Explore {candidate.presentation?.name ?? "workspace"}
                </Button>
              </Card>
            ))}
          </Grid>
        </Flex>
      ) : null}
      <Flex direction="column" gap="3">
        <Flex justify="between" align="center">
          <Heading size="3">From a source address</Heading>
        </Flex>
        <TextField.Root
          size="3"
          aria-label="Workspace source address"
          placeholder="https://github.com/owner/workspace"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          disabled={inspecting}
        />
        <details>
          <summary
            style={{
              fontSize: 13,
              cursor: "pointer",
              minHeight: 44,
              alignContent: "center",
            }}
          >
            Private repository?
          </summary>
          <TextField.Root
            size="3"
            aria-label="Connected account name"
            placeholder="Connected account name"
            value={credential}
            onChange={(event) => setCredential(event.target.value)}
          />
          <Text as="p" size="1" color="gray" mt="1">
            Use the name of an account already connected for this repository.
          </Text>
        </details>
        <Flex justify="end">
          <Button
            size="3"
            variant="soft"
            disabled={!canInspect || inspecting}
            loading={inspecting}
            onClick={() =>
              void inspect({
                url: url.trim(),
                ...(credential.trim() ? { credential: credential.trim() } : {}),
              })
            }
          >
            Review workspace
          </Button>
        </Flex>
      </Flex>
      <Flex direction="column" gap="3">
        <Heading size="3">Start from an example</Heading>
        <Grid columns={{ initial: "1", sm: "2" }} gap="3">
          {workspaceExamples.map((entry) => (
            <Card key={entry.url}>
              <Heading size="3">{entry.name}</Heading>
              <Text as="p" size="2" color="gray" mt="2">
                {entry.description}
              </Text>
              <Button
                mt="3"
                variant="soft"
                disabled={inspecting}
                onClick={() => void inspect({ url: entry.url })}
              >
                Review {entry.name}
              </Button>
            </Card>
          ))}
        </Grid>
      </Flex>
    </Flex>
  );
}
