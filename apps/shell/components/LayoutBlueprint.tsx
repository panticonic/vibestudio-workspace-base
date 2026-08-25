import { Flex, Text } from "@radix-ui/themes";

import { dropPreview, type LayoutGeometry, type Rect } from "../layout/dropGeometry";
import type { LayoutDropTarget } from "../layout/types";
import { usePanelTree } from "../shell/hooks/PanelTreeContext";
import { PanelIcon } from "./PanelIcon";

interface LayoutBlueprintProps {
  geometry: LayoutGeometry;
  target: LayoutDropTarget | null;
  /** The pane being lifted, drawn as an empty socket rather than as content. */
  sourcePaneId: string | null;
  /** The dragged panel, named and iconed on the highlight. */
  sourcePanelId: string;
  /** Title captured when the drag began; the live tree title wins if it has one. */
  sourceTitle: string;
}

/**
 * The layout, drawn as itself, while a placement drag is in flight.
 *
 * Panel views are native and composite above the shell, so they are hidden for
 * the duration of the gesture and this is what stands in for them: every pane
 * as a sheet of glass at exactly its own geometry, and one saturated highlight
 * where the drop will land. Preview and outcome are the same resolved target,
 * so the highlight cannot promise a placement the engine will not make.
 */
export function LayoutBlueprint({
  geometry,
  target,
  sourcePaneId,
  sourcePanelId,
  sourceTitle,
}: LayoutBlueprintProps) {
  const { panelMap } = usePanelTree();
  const sourcePanel = panelMap.get(sourcePanelId);
  const origin = geometry.viewport;
  const local = (rect: Rect) => ({
    left: rect.x - origin.x,
    top: rect.y - origin.y,
    width: rect.width,
    height: rect.height,
  });
  const preview = target ? dropPreview(target, geometry) : null;
  const highlightedPaneId = target && target.kind !== "new-column" ? target.paneId : null;

  return (
    <div
      className="layout-blueprint"
      data-layout-blueprint="true"
      style={{ position: "absolute", inset: 0, zIndex: 10, pointerEvents: "none" }}
    >
      {geometry.panes.map((pane, index) => {
        const panel = panelMap.get(pane.panelId);
        const lifted = pane.paneId === sourcePaneId;
        return (
          <Flex
            key={pane.paneId}
            className="layout-blueprint__pane"
            data-blueprint-pane={pane.paneId}
            data-lifted={lifted ? "true" : "false"}
            data-dimmed={
              !lifted && highlightedPaneId !== null && highlightedPaneId !== pane.paneId
                ? "true"
                : "false"
            }
            align="center"
            justify="center"
            gap="2"
            style={{
              position: "absolute",
              ...local(pane.rect),
              padding: 8,
              overflow: "hidden",
              animationDelay: `${Math.min(index, 6) * 18}ms`,
            }}
          >
            {!lifted && highlightedPaneId !== pane.paneId && (
              <>
                <PanelIcon
                  icon={panel?.icon}
                  iconVersion={panel?.iconVersion}
                  iconState={panel?.iconState}
                  source={panel?.source}
                  favicon={panel?.favicon}
                  size={16}
                  fallback={panel?.source?.startsWith("browser:") ? "browser" : "panel"}
                />
                <Text
                  size="2"
                  color="gray"
                  style={{
                    maxWidth: "70%",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {panel?.title ?? "Panel"}
                </Text>
              </>
            )}
          </Flex>
        );
      })}

      {preview?.kind === "region" && (
        <Flex
          className="layout-blueprint__preview"
          data-layout-drop-preview="region"
          align="center"
          justify="center"
          style={{ position: "absolute", ...local(preview.rect) }}
        >
          <Flex className="layout-blueprint__label" align="center" gap="2">
            <PanelIcon
              icon={sourcePanel?.icon}
              iconVersion={sourcePanel?.iconVersion}
              iconState={sourcePanel?.iconState}
              source={sourcePanel?.source}
              favicon={sourcePanel?.favicon}
              size={14}
              fallback={sourcePanel?.source?.startsWith("browser:") ? "browser" : "panel"}
            />
            <Text
              size="2"
              weight="medium"
              style={{
                maxWidth: Math.max(80, preview.rect.width - 80),
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {sourcePanel?.title ?? sourceTitle}
            </Text>
          </Flex>
        </Flex>
      )}

      {preview?.kind === "insertion" && (
        <div
          className="layout-blueprint__insertion"
          data-layout-drop-preview="insertion"
          style={{ position: "absolute", ...local(preview.rect) }}
        />
      )}
    </div>
  );
}
