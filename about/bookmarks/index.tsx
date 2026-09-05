import { useMemo, useState } from "react";
import {
  Button,
  Card,
  Dialog,
  Flex,
  Heading,
  Spinner,
  Text,
  TextField,
} from "@radix-ui/themes";
import {
  BookmarkIcon,
  Pencil1Icon,
  ReloadIcon,
  TrashIcon,
} from "@radix-ui/react-icons";
import type { StoredBookmark } from "@vibestudio/browser-data";
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

const readBookmarks = () => browserData.searchBookmarks("");

function BookmarksPage() {
  const {
    data: bookmarks = [],
    loading,
    error,
    refresh,
  } = useAsyncResource(readBookmarks);
  const actions = useRecordActions();
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<StoredBookmark | null>(null);
  const [title, setTitle] = useState("");
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle
      ? bookmarks.filter(
          (bookmark) =>
            bookmark.title.toLowerCase().includes(needle) ||
            bookmark.url?.toLowerCase().includes(needle),
        )
      : bookmarks;
  }, [bookmarks, query]);
  const saving = editing !== null && actions.pending.has(editing.id);

  return (
    <AboutPage
      icon={<BookmarkIcon />}
      title="Bookmarks"
      subtitle="Websites saved in this browser environment"
      maxWidth={900}
      actions={
        <Button
          variant="soft"
          disabled={loading}
          onClick={() => void refresh()}
        >
          <ReloadIcon /> Refresh
        </Button>
      }
    >
      <Section>
        <TextField.Root
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="Search bookmarks"
          aria-label="Search bookmarks"
        />
      </Section>
      {loading && bookmarks.length === 0 ? (
        <Flex align="center" gap="2" role="status">
          <Spinner />
          <Text color="gray">Loading bookmarks…</Text>
        </Flex>
      ) : null}
      {error || (!editing && actions.error) ? (
        <Text color="red" role="alert">
          {error || actions.error}
        </Text>
      ) : null}
      {!loading && !error && visible.length === 0 ? (
        <Text color="gray">
          {query.trim()
            ? "No bookmarks match your search."
            : "No bookmarks yet. Save a page to find it here."}
        </Text>
      ) : null}
      <Flex direction="column" gap="2">
        {visible.map((bookmark) => (
          <Card key={bookmark.id}>
            <Flex
              justify="between"
              align={{ initial: "stretch", sm: "center" }}
              direction={{ initial: "column", sm: "row" }}
              gap="3"
            >
              <Flex direction="column" style={{ minWidth: 0, flex: 1 }}>
                <Heading size="3" style={{ overflowWrap: "anywhere" }}>
                  {bookmark.title}
                </Heading>
                <Text
                  size="1"
                  color="gray"
                  truncate
                  title={bookmark.url ?? bookmark.folder_path}
                >
                  {bookmark.url ?? bookmark.folder_path}
                </Text>
              </Flex>
              <Flex gap="2" wrap="wrap" style={{ flexShrink: 0 }}>
                {bookmark.url ? (
                  <Button
                    size="1"
                    disabled={actions.pending.has(bookmark.id)}
                    onClick={() =>
                      void actions.run(bookmark.id, () =>
                        openPanel(bookmark.url!, { focus: true }),
                      )
                    }
                  >
                    Open
                  </Button>
                ) : null}
                <Button
                  size="1"
                  variant="soft"
                  disabled={actions.pending.has(bookmark.id)}
                  onClick={() => {
                    setEditing(bookmark);
                    setTitle(bookmark.title);
                  }}
                >
                  <Pencil1Icon /> Edit
                </Button>
                <Button
                  size="1"
                  color="red"
                  variant="soft"
                  disabled={actions.pending.has(bookmark.id)}
                  onClick={() =>
                    void actions.run(bookmark.id, async () => {
                      await browserData.deleteBookmark(bookmark.id);
                      await refresh();
                    })
                  }
                >
                  <TrashIcon /> Remove
                </Button>
              </Flex>
            </Flex>
          </Card>
        ))}
      </Flex>
      <Dialog.Root
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open && !saving) setEditing(null);
        }}
      >
        <Dialog.Content maxWidth="440px" aria-describedby={undefined}>
          <Dialog.Title>Edit bookmark</Dialog.Title>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!editing || !title.trim()) return;
              void actions.run(editing.id, async () => {
                await browserData.updateBookmark(editing.id, {
                  title: title.trim(),
                });
                setEditing(null);
                await refresh();
              });
            }}
          >
            <Text as="label" size="2" weight="medium" htmlFor="bookmark-title">
              Title
            </Text>
            <TextField.Root
              id="bookmark-title"
              mt="2"
              autoFocus
              value={title}
              disabled={saving}
              onChange={(event) => setTitle(event.currentTarget.value)}
            />
            {actions.error ? (
              <Text as="p" color="red" role="alert" mt="2">
                {actions.error}
              </Text>
            ) : null}
            <Flex gap="2" justify="end" mt="4">
              <Button
                type="button"
                variant="soft"
                disabled={saving}
                onClick={() => setEditing(null)}
              >
                Cancel
              </Button>
              <Button type="submit" loading={saving} disabled={!title.trim()}>
                Save
              </Button>
            </Flex>
          </form>
        </Dialog.Content>
      </Dialog.Root>
    </AboutPage>
  );
}

export default function AboutPanelRoot() {
  return (
    <AboutThemeRoot>
      <BookmarksPage />
    </AboutThemeRoot>
  );
}
