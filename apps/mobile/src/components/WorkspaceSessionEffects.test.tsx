import { act, render, waitFor } from "@testing-library/react-native";
import { WorkspaceSessionEffects } from "./WorkspaceSessionEffects";
import { handleExternalOpen } from "../services/oauthLoopback";
import { handleMobileAppLifecycleEvent } from "../services/appUpdatePrompt";
import type {
  MobileWorkspaceDirectory,
  MobileWorkspaceSession,
} from "../services/workspaceDirectory";

jest.mock("../services/oauthLoopback", () => ({
  handleExternalOpen: jest.fn(async () => undefined),
}));
jest.mock("../services/appUpdatePrompt", () => ({
  handleMobileAppLifecycleEvent: jest.fn(),
}));

function setup(workspaceId = "personal") {
  const listeners = new Map<string, (payload: unknown) => void>();
  const directListeners = new Map<string, (payload: unknown) => void>();
  const stop = jest.fn();
  const client = {
    panels: { updateTheme: jest.fn(async (_theme: string) => undefined) },
    hostLaunch: {
      configuredCandidate: jest.fn(async () => ({
        source: "apps/mobile",
        name: "mobile",
      })),
    },
    events: {
      subscribeAll: jest.fn(async (_topics: Iterable<string>) => undefined),
      unsubscribeMany: jest.fn(async (_topics: Iterable<string>) => undefined),
      on: jest.fn((event: string, listener: (payload: unknown) => void) => {
        listeners.set(event, listener);
        return stop;
      }),
    },
    onDirectEvent: jest.fn(
      (event: string, listener: (payload: unknown) => void) => {
        directListeners.set(event, listener);
        return stop;
      },
    ),
    transport: { onReconnect: jest.fn(() => stop) },
  };
  const session = { workspaceId, client };
  const directory = {
    systemWorkspaceId: "system",
    entries: [{ workspaceId, name: workspaceId }],
    sessions: new Map([[workspaceId, session]]),
    activate: jest.fn(),
  };
  const notify = jest.fn();
  const props = {
    directory: directory as unknown as MobileWorkspaceDirectory,
    session: session as unknown as MobileWorkspaceSession,
    notify,
    theme: "dark" as const,
  };
  return {
    client,
    directory,
    session,
    notify,
    props,
    stop,
    direct: (event: string, payload: unknown) =>
      directListeners.get(event)?.(payload),
    emit: (event: string, payload: unknown) => listeners.get(event)?.(payload),
  };
}

beforeEach(() => jest.clearAllMocks());

it("presents an unvisited workspace's events through the account host and stops on removal", () => {
  const f = setup();
  const view = render(<WorkspaceSessionEffects {...f.props} />);
  f.emit("notification:show", {
    id: "notice",
    title: "Ready",
    message: "Your tools are ready",
  });
  expect(f.notify).toHaveBeenCalledWith(
    expect.objectContaining({
      id: '["personal","notice"]',
      title: "personal · Ready",
      actionLabel: "Open workspace",
    }),
  );
  expect(f.directory.activate).not.toHaveBeenCalled();
  f.directory.sessions.delete("personal");
  f.emit("notification:show", { title: "Stale" });
  expect(f.notify).toHaveBeenCalledTimes(1);
  view.unmount();
  expect(f.stop).toHaveBeenCalledTimes(4);
  f.emit("notification:show", { title: "Stopped" });
  expect(f.notify).toHaveBeenCalledTimes(1);
});

it("updates theme for connected System and Personal panels without presenting either workspace", () => {
  const system = setup("system");
  const personal = setup();
  const view = render(
    <>
      <WorkspaceSessionEffects {...system.props} />
      <WorkspaceSessionEffects {...personal.props} />
    </>,
  );
  expect(system.client.panels.updateTheme).toHaveBeenCalledWith("dark");
  expect(personal.client.panels.updateTheme).toHaveBeenCalledWith("dark");
  view.rerender(
    <>
      <WorkspaceSessionEffects {...system.props} theme="light" />
      <WorkspaceSessionEffects {...personal.props} theme="light" />
    </>,
  );
  expect(system.client.panels.updateTheme).toHaveBeenLastCalledWith("light");
  expect(personal.client.panels.updateTheme).toHaveBeenLastCalledWith("light");
  expect(system.directory.activate).not.toHaveBeenCalled();
  expect(personal.directory.activate).not.toHaveBeenCalled();
});

it("delivers a background external handoff to its captured client and ignores retired-owner failure", async () => {
  const f = setup("system");
  let reject!: (error: Error) => void;
  jest.mocked(handleExternalOpen).mockImplementationOnce(
    () =>
      new Promise<void>((_resolve, fail) => {
        reject = fail;
      }),
  );
  render(<WorkspaceSessionEffects {...f.props} />);
  const payload = {
    url: "https://provider.example/authorize",
    oauthAppScheme: { transactionId: "system-transaction" },
  };
  f.emit("external-open:open", payload);
  expect(handleExternalOpen).toHaveBeenCalledWith(f.client, payload);
  f.directory.sessions.delete("system");
  await act(async () => {
    reject(new Error("session removed"));
  });
  expect(f.notify).not.toHaveBeenCalled();
  f.emit("external-open:open", payload);
  expect(handleExternalOpen).toHaveBeenCalledTimes(1);
});

it("attributes external handoff failure to its owner without changing the active workspace", async () => {
  const f = setup();
  jest
    .mocked(handleExternalOpen)
    .mockRejectedValueOnce(new Error("Browser unavailable"));
  render(<WorkspaceSessionEffects {...f.props} />);
  f.emit("external-open:open", { url: "https://provider.example" });
  await waitFor(() =>
    expect(f.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "personal · Could not open external link",
        message: "Browser unavailable",
      }),
    ),
  );
  expect(f.directory.activate).not.toHaveBeenCalled();
});

it("subscribes to existing native app lifecycle only in System, even while its panels are unvisited", async () => {
  const system = setup("system");
  const personal = setup();
  render(
    <>
      <WorkspaceSessionEffects {...system.props} />
      <WorkspaceSessionEffects {...personal.props} />
    </>,
  );
  const event = {
    type: "update-available",
    target: "react-native",
    source: "apps/mobile",
  };
  system.emit("apps:lifecycle", event);
  personal.emit("apps:lifecycle", event);
  await waitFor(() =>
    expect(handleMobileAppLifecycleEvent).toHaveBeenCalledTimes(1),
  );
  expect(handleMobileAppLifecycleEvent).toHaveBeenCalledWith(
    event,
    expect.objectContaining({
      shellClient: system.client,
      selectedSource: "apps/mobile",
    }),
  );
  expect(personal.client.hostLaunch.configuredCandidate).not.toHaveBeenCalled();
  expect(personal.client.events.subscribeAll).toHaveBeenCalledWith([
    "notification:show",
    "external-open:open",
  ]);
});

it("does not present old app lifecycle work after its System session is replaced", async () => {
  const f = setup("system");
  let resolve!: (candidate: { source: string; name: string }) => void;
  f.client.hostLaunch.configuredCandidate.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const view = render(<WorkspaceSessionEffects {...f.props} />);
  f.emit("apps:lifecycle", {
    type: "update-available",
    target: "react-native",
    source: "apps/mobile",
  });
  f.directory.sessions.set("system", { ...f.session });
  await act(async () => {
    resolve({ source: "apps/mobile", name: "mobile" });
  });
  expect(handleMobileAppLifecycleEvent).not.toHaveBeenCalled();
  view.unmount();
  expect(f.client.events.unsubscribeMany).toHaveBeenCalledWith([
    "notification:show",
    "external-open:open",
    "apps:lifecycle",
  ]);
});

it("handles targeted OAuth delivery once, independently of the broadcast watch", () => {
  const f = setup("system");
  const view = render(<WorkspaceSessionEffects {...f.props} />);
  const targeted = {
    url: "https://provider.example/authorize",
    oauthAppScheme: { transactionId: "targeted-transaction" },
  };
  f.direct("external-open:open", targeted);
  expect(handleExternalOpen).toHaveBeenCalledTimes(1);
  expect(handleExternalOpen).toHaveBeenLastCalledWith(f.client, targeted);
  const broadcast = { url: "https://website.example/" };
  f.emit("external-open:open", broadcast);
  expect(handleExternalOpen).toHaveBeenCalledTimes(2);
  expect(handleExternalOpen).toHaveBeenLastCalledWith(f.client, broadcast);
  view.unmount();
  f.direct("external-open:open", targeted);
  f.emit("external-open:open", broadcast);
  expect(handleExternalOpen).toHaveBeenCalledTimes(2);
});
