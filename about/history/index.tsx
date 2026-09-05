import { useCallback, useState } from "react";
import {
  AlertDialog,
  Button,
  Card,
  Flex,
  Heading,
  Select,
  Spinner,
  Text,
  TextField,
} from "@radix-ui/themes";
import { ClockIcon, ReloadIcon, TrashIcon } from "@radix-ui/react-icons";
import { browserData, openPanel } from "@workspace/runtime";
import {
  AboutPage,
  AboutThemeRoot,
  Section,
} from "../../packages/about-shared/ui";
import {
  useAsyncResource,
  useRecordActions,
} from "../../packages/about-shared/asyncState";

function HistoryPage() {
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [clearRange, setClearRange] = useState("day");
  const [confirmClear, setConfirmClear] = useState(false);
  const read = useCallback(
    () => browserData.getHistory({ search: search || undefined, limit: 500 }),
    [search],
  );
  const {
    data: history = [],
    loading,
    error,
    refresh,
  } = useAsyncResource(read);
  const actions = useRecordActions();
  const clearing = actions.pending.has("clear");
  const clearSelectedRange = () =>
    actions.run("clear", async () => {
      const durations: Record<string, number> = {
        hour: 60 * 60 * 1000,
        day: 24 * 60 * 60 * 1000,
        week: 7 * 24 * 60 * 60 * 1000,
        month: 28 * 24 * 60 * 60 * 1000,
      };
      const now = Date.now();
      if (clearRange === "all") await browserData.clearAllHistory();
      else
        await browserData.deleteHistoryRange(now - durations[clearRange]!, now);
      setConfirmClear(false);
      await refresh();
    });

  return (
    <AboutPage
      icon={<ClockIcon />}
      title="History"
      subtitle="Pages visited in this browser environment"
      maxWidth={900}
      actions={
        <Flex gap="2" wrap="wrap">
          <Button
            variant="soft"
            disabled={loading}
            onClick={() => void refresh()}
          >
            <ReloadIcon /> Refresh
          </Button>
          <Select.Root
            disabled={clearing}
            value={clearRange}
            onValueChange={setClearRange}
          >
            <Select.Trigger aria-label="History clear range" />
            <Select.Content>
              <Select.Item value="hour">Last hour</Select.Item>
              <Select.Item value="day">Last 24 hours</Select.Item>
              <Select.Item value="week">Last 7 days</Select.Item>
              <Select.Item value="month">Last 4 weeks</Select.Item>
              <Select.Item value="all">All time</Select.Item>
            </Select.Content>
          </Select.Root>
          <Button
            color="red"
            variant="soft"
            disabled={clearing}
            onClick={() => setConfirmClear(true)}
          >
            Clear
          </Button>
        </Flex>
      }
    >
      <Section>
        <TextField.Root
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              if (search === query.trim()) void refresh();
              else setSearch(query.trim());
            }
          }}
          placeholder="Search history"
          aria-label="Search history"
        />
      </Section>
      {loading && history.length === 0 ? <Spinner /> : null}
      {error || (!confirmClear && actions.error) ? (
        <Text color="red" role="alert">
          {error || actions.error}
        </Text>
      ) : null}
      {!loading && !error && history.length === 0 ? (
        <Text color="gray">No history found.</Text>
      ) : null}
      <Flex direction="column" gap="2">
        {history.map((entry) => (
          <Card key={entry.id}>
            <Flex
              justify="between"
              align={{ initial: "stretch", sm: "center" }}
              direction={{ initial: "column", sm: "row" }}
              gap="3"
            >
              <Flex direction="column" style={{ minWidth: 0, flex: 1 }}>
                <Heading size="3" style={{ overflowWrap: "anywhere" }}>
                  {entry.title || entry.url}
                </Heading>
                <Text size="1" color="gray" truncate>
                  {entry.url}
                </Text>
                <Text size="1" color="gray">
                  {new Date(entry.last_visit).toLocaleString()}
                </Text>
              </Flex>
              <Flex gap="2" wrap="wrap">
                <Button
                  size="1"
                  disabled={actions.pending.has(entry.id)}
                  onClick={() =>
                    void actions.run(entry.id, () =>
                      openPanel(entry.url, { focus: true }),
                    )
                  }
                >
                  Open
                </Button>
                <Button
                  size="1"
                  color="red"
                  variant="soft"
                  aria-label={`Remove ${entry.title || entry.url} from history`}
                  disabled={clearing || actions.pending.has(entry.id)}
                  onClick={() =>
                    void actions.run(entry.id, async () => {
                      await browserData.deleteHistoryEntry(entry.id);
                      await refresh();
                    })
                  }
                >
                  <TrashIcon />
                </Button>
              </Flex>
            </Flex>
          </Card>
        ))}
      </Flex>
      <AlertDialog.Root
        open={confirmClear}
        onOpenChange={(open) => {
          if (!clearing) setConfirmClear(open);
        }}
      >
        <AlertDialog.Content maxWidth="440px">
          <AlertDialog.Title>Clear browsing history?</AlertDialog.Title>
          <AlertDialog.Description>
            {clearRange === "all"
              ? "All browsing history"
              : "History from the selected range"}{" "}
            will be permanently removed. This cannot be undone.
          </AlertDialog.Description>
          {actions.error ? (
            <Text as="p" color="red" role="alert" mt="2">
              {actions.error}
            </Text>
          ) : null}
          <Flex gap="2" justify="end" mt="4">
            <AlertDialog.Cancel>
              <Button variant="soft" disabled={clearing}>
                Cancel
              </Button>
            </AlertDialog.Cancel>
            <Button
              color="red"
              loading={clearing}
              onClick={() => void clearSelectedRange()}
            >
              Clear history
            </Button>
          </Flex>
        </AlertDialog.Content>
      </AlertDialog.Root>
    </AboutPage>
  );
}

export default function AboutPanelRoot() {
  return (
    <AboutThemeRoot>
      <HistoryPage />
    </AboutThemeRoot>
  );
}
