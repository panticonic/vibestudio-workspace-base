import { useState } from "react";
import { Text } from "react-native";
import { useAtomValue, useSetAtom } from "jotai";
import { themeColorsAtom } from "../state/themeAtoms";
import { showActionSheetAtom } from "../state/actionSheetAtoms";
import { type } from "../design/tokens";
import { Button, Card, SectionHeader } from "./ui/primitives";

export function WorkspaceCookiesCard({
  workspaceName,
  onClear,
}: {
  workspaceName: string;
  onClear(): Promise<void>;
}) {
  const colors = useAtomValue(themeColorsAtom);
  const review = useSetAtom(showActionSheetAtom);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  return (
    <>
      <SectionHeader label="This device" />
      <Card>
        <Text style={[type.heading, { color: colors.text }]}>
          Website cookies
        </Text>
        <Text style={[type.caption, { color: colors.textSecondary }]}>
          {workspaceName} stores its website sign-ins separately on this device.
        </Text>
        {message && (
          <Text
            accessibilityRole="alert"
            style={{ color: colors.textSecondary }}
          >
            {message}
          </Text>
        )}
        <Button
          label="Clear website cookies"
          disabled={busy}
          onPress={() =>
            review({
              title: `${workspaceName} · Clear website cookies?`,
              subtitle:
                "This may sign you out of websites in this workspace on this device. Other workspaces and your server browser vault are unaffected.",
              items: [{ id: "clear", label: "Clear cookies", tone: "danger" }],
              onSelect: async () => {
                setBusy(true);
                setMessage(null);
                try {
                  await onClear();
                  setMessage(`Website cookies cleared for ${workspaceName}.`);
                } catch (error) {
                  setMessage(
                    error instanceof Error ? error.message : String(error),
                  );
                } finally {
                  setBusy(false);
                }
              },
            })
          }
        />
      </Card>
    </>
  );
}
