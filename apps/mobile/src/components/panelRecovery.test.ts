import type { PanelWebViewHandle } from "./PanelWebView";
import { recoverCurrentPanels } from "./panelRecovery";

function handle(): PanelWebViewHandle {
  return {
    injectTheme: jest.fn(),
    dispatchHostEvent: jest.fn(),
    deliverEnvelope: jest.fn(),
    deliverRecovery: jest.fn(),
    navigate: jest.fn(),
    goBack: jest.fn(),
    goForward: jest.fn(),
    reload: jest.fn(),
    stop: jest.fn(),
  };
}

it("signals only the exact retained managed document with current ownership", () => {
  const current = handle();
  const replaced = handle();
  const browser = handle();
  const handles = new Map([
    ["current", current],
    ["replaced", replaced],
    ["browser", browser],
  ]);

  const reload = jest.fn();
  recoverCurrentPanels(
    "resubscribe",
    [
      { panelId: "current", managed: true },
      { panelId: "replaced", managed: true },
      { panelId: "browser", managed: false },
      { panelId: "destroyed", managed: true },
    ],
    handles,
    (entry) => entry.panelId === "current",
    reload,
  );

  expect(current.deliverRecovery).toHaveBeenCalledWith("resubscribe");
  expect(replaced.deliverRecovery).not.toHaveBeenCalled();
  expect(browser.deliverRecovery).not.toHaveBeenCalled();
  expect(reload).not.toHaveBeenCalled();
});

it("selectively reloads the same current owner on cold recovery", () => {
  const current = handle();
  const stale = handle();
  const reload = jest.fn();

  recoverCurrentPanels(
    "cold-recover",
    [
      { panelId: "current", managed: true },
      { panelId: "stale", managed: true },
    ],
    new Map([
      ["current", current],
      ["stale", stale],
    ]),
    (entry) => entry.panelId === "current",
    reload,
  );

  expect(reload).toHaveBeenCalledWith("current", current);
  expect(stale.reload).not.toHaveBeenCalled();
  expect(current.deliverRecovery).not.toHaveBeenCalled();
});
