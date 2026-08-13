import { Badge, Button, Card, Flex, Heading, Spinner, Table, Text } from "@radix-ui/themes";
import { LockClosedIcon } from "@radix-ui/react-icons";
import { useState } from "react";
import type { StoredHistory } from "@vibestudio/browser-data/client";
import { browserData, relativeTime, useAsync } from "../useBrowserData";

export function InspectTab(props: { now: number }) {
  const [managerError, setManagerError] = useState<string | null>(null);
  const openManager = async () => {
    setManagerError(null);
    try {
      await browserData.openBrowserPrivacyManager("inspect");
    } catch (error) {
      setManagerError(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <Flex direction="column" gap="4" p="4" style={{ overflowY: "auto", height: "100%" }}>
      <Card>
        <Flex justify="between" align="center" gap="3" wrap="wrap">
          <div>
            <Heading size="2">Site data & saved passwords</Heading>
            <Text size="1" color="gray">
              Inspect current-site cookie and password counts in Vibestudio's trusted privacy
              manager.
            </Text>
          </div>
          <Button variant="soft" onClick={() => void openManager()}>
            <LockClosedIcon /> Inspect protected data
          </Button>
        </Flex>
        {managerError && (
          <Text size="1" color="red" as="div" mt="2" role="alert">
            {managerError}
          </Text>
        )}
      </Card>
      <HistoryList now={props.now} />
    </Flex>
  );
}

function HistoryList(props: { now: number }) {
  const history = useAsync<StoredHistory[]>(() => browserData.getHistory({ limit: 100 }), []);
  return (
    <Card>
      <Heading size="2" mb="2">
        Recent history
      </Heading>
      {history.state.status === "loading" && <Spinner size="1" />}
      {history.state.error && (
        <Text color="red" size="1">
          {history.state.error}
        </Text>
      )}
      <Table.Root size="1">
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeaderCell>Page</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell>Visits</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell>Last visit</Table.ColumnHeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {history.state.data?.map((entry) => (
            <Table.Row key={entry.id}>
              <Table.RowHeaderCell>
                <Text truncate style={{ maxWidth: 440 }}>
                  {entry.title || entry.url}
                </Text>
              </Table.RowHeaderCell>
              <Table.Cell>
                <Badge color="gray">{entry.visit_count}</Badge>
              </Table.Cell>
              <Table.Cell>{relativeTime(entry.last_visit, props.now)}</Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
    </Card>
  );
}
