import {
  Badge,
  Button,
  Card,
  Flex,
  Progress,
  Spinner,
  Text,
} from "@radix-ui/themes";
import { browserData } from "@workspace/runtime";
import { AboutPage, AboutThemeRoot } from "../../packages/about-shared/ui";
import {
  useAsyncResource,
  useRecordActions,
} from "../../packages/about-shared/asyncState";

const readDownloads = () => browserData.listDownloads();
const sizeFormat = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 1,
});
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${sizeFormat.format(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${sizeFormat.format(bytes / 1024 ** 2)} MB`;
  return `${sizeFormat.format(bytes / 1024 ** 3)} GB`;
}

export default function DownloadsPanel() {
  const {
    data: downloads = [],
    loading,
    error,
    refresh,
  } = useAsyncResource(readDownloads, 1_000);
  const actions = useRecordActions();
  return (
    <AboutThemeRoot>
      <AboutPage
        title="Downloads"
        subtitle="Files saved by this browser environment"
        maxWidth={900}
      >
        {error || actions.error ? (
          <Text color="red" role="alert">
            {error || actions.error}
          </Text>
        ) : null}
        {loading && downloads.length === 0 && !error ? (
          <Flex align="center" gap="2" role="status">
            <Spinner />
            <Text color="gray">Loading downloads…</Text>
          </Flex>
        ) : null}
        {!loading && !error && downloads.length === 0 ? (
          <Text color="gray">No browser downloads yet.</Text>
        ) : null}
        {downloads.map((download) => {
          const pending = actions.pending.has(download.id);
          const active =
            download.state === "progressing" || download.state === "paused";
          const control = (operation: () => Promise<void>) =>
            void actions.run(download.id, async () => {
              await operation();
              await refresh();
            });
          return (
            <Card key={download.id}>
              <Flex justify="between" align="start" gap="3">
                <Flex
                  direction="column"
                  gap="1"
                  style={{ minWidth: 0, flex: 1 }}
                >
                  <Text weight="bold" style={{ overflowWrap: "anywhere" }}>
                    {download.filename}
                  </Text>
                  <Text
                    size="1"
                    color="gray"
                    truncate
                    title={download.origin ?? download.url}
                  >
                    {download.origin ?? download.url}
                  </Text>
                  <Text size="1" color="gray">
                    {formatBytes(download.receivedBytes)}
                    {download.totalBytes > 0
                      ? ` of ${formatBytes(download.totalBytes)}`
                      : ""}
                  </Text>
                </Flex>
                <Badge
                  color={
                    download.state === "completed"
                      ? "green"
                      : download.state === "interrupted"
                        ? "red"
                        : "gray"
                  }
                  style={{ flexShrink: 0 }}
                >
                  {download.state.charAt(0).toUpperCase() +
                    download.state.slice(1)}
                </Badge>
              </Flex>
              {active ? (
                <Progress
                  mt="3"
                  aria-label={`Download progress for ${download.filename}`}
                  value={
                    download.totalBytes > 0
                      ? Math.min(
                          100,
                          (download.receivedBytes / download.totalBytes) * 100,
                        )
                      : null
                  }
                />
              ) : null}
              {active || download.state === "completed" ? (
                <Flex gap="2" mt="3" wrap="wrap">
                  {download.state === "progressing" ? (
                    <Button
                      size="1"
                      variant="soft"
                      disabled={pending}
                      onClick={() =>
                        control(() => browserData.pauseDownload(download.id))
                      }
                    >
                      Pause
                    </Button>
                  ) : null}
                  {download.state === "paused" ? (
                    <Button
                      size="1"
                      variant="soft"
                      disabled={pending}
                      onClick={() =>
                        control(() => browserData.resumeDownload(download.id))
                      }
                    >
                      Resume
                    </Button>
                  ) : null}
                  {active ? (
                    <Button
                      size="1"
                      color="red"
                      variant="soft"
                      disabled={pending}
                      onClick={() =>
                        control(() => browserData.cancelDownload(download.id))
                      }
                    >
                      Cancel
                    </Button>
                  ) : null}
                  {download.state === "completed" ? (
                    <>
                      <Button
                        size="1"
                        disabled={pending}
                        onClick={() =>
                          void actions.run(download.id, () =>
                            browserData.openDownload(download.id),
                          )
                        }
                      >
                        Open
                      </Button>
                      <Button
                        size="1"
                        variant="soft"
                        disabled={pending}
                        onClick={() =>
                          void actions.run(download.id, () =>
                            browserData.revealDownload(download.id),
                          )
                        }
                      >
                        Show in folder
                      </Button>
                    </>
                  ) : null}
                </Flex>
              ) : null}
            </Card>
          );
        })}
      </AboutPage>
    </AboutThemeRoot>
  );
}
