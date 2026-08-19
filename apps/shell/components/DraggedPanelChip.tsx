import { Box, Text } from "@radix-ui/themes";

/**
 * The thing that follows the cursor while a panel is being dragged. One
 * component for both drag sources — a tree row and a pane read as the same
 * gesture, so they must look the same in flight.
 */
export function DraggedPanelChip({ title, childCount }: { title: string; childCount?: number }) {
  return (
    <Box
      style={{
        padding: "2px 8px",
        backgroundColor: "var(--gray-a2)",
        border: "1px dashed var(--accent-8)",
        borderRadius: "var(--radius-2)",
        opacity: 0.9,
        maxWidth: "150px",
      }}
    >
      <Text
        size="1"
        style={{
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          color: "var(--gray-11)",
        }}
      >
        {title}
        {childCount !== undefined && childCount > 1 && ` (+${childCount - 1})`}
      </Text>
    </Box>
  );
}
