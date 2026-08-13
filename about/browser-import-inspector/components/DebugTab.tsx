import { Callout, Button, Card, Flex, Heading, Text } from "@radix-ui/themes";
import { GearIcon } from "@radix-ui/react-icons";
import { useState } from "react";
import { browserData } from "../useBrowserData";
import type { ImportSourceSelection } from "./ImportSourceRail";

export function DebugTab(props: { selection: ImportSourceSelection | null }) {
  const [managerError, setManagerError] = useState<string | null>(null);
  const openManager = async () => {
    setManagerError(null);
    try {
      await browserData.openBrowserPrivacyManager("debug");
    } catch (error) {
      setManagerError(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <Flex direction="column" gap="4" p="4" style={{ overflowY: "auto", height: "100%" }}>
      <Card>
        <Flex justify="between" align="center" gap="3" wrap="wrap">
          <div>
            <Heading size="2">Cookie sessions & projection</Heading>
            <Text size="1" color="gray">
              Review shared-vault status, end the browser session, or clear shared site data in
              Vibestudio's trusted privacy manager. Desktop owns browser projection diagnostics.
            </Text>
          </div>
          <Button variant="soft" onClick={() => void openManager()}>
            <GearIcon /> Open privacy diagnostics
          </Button>
        </Flex>
        {managerError && (
          <Text size="1" color="red" as="div" mt="2" role="alert">
            {managerError}
          </Text>
        )}
      </Card>
      <Card>
        <Heading size="2">Import source diagnostics</Heading>
        {props.selection ? (
          <>
            <Text size="2" as="div">
              {props.selection.source.displayName}
            </Text>
            <Text size="1" color="gray" as="div">
              {props.selection.host.displayName} · {props.selection.source.status}
            </Text>
            {props.selection.source.warnings.length === 0 ? (
              <Text size="1" color="gray" as="div" mt="2">
                No provider warnings.
              </Text>
            ) : (
              props.selection.source.warnings.map((warning) => (
                <Callout.Root color="amber" size="1" mt="2" key={warning}>
                  <Callout.Text>{warning}</Callout.Text>
                </Callout.Root>
              ))
            )}
          </>
        ) : (
          <Text size="1" color="gray">
            Choose a device and browser to see provider diagnostics.
          </Text>
        )}
      </Card>
    </Flex>
  );
}
