import { Alert } from "react-native";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import type { ShellClient } from "../services/shellClient";
import { BrowserPrivacyManager } from "./BrowserPrivacyManager";

function makeClient(overrides: Partial<Record<keyof ShellClient["browserPrivacy"], jest.Mock>> = {}) {
  return {
    listPasswordSummariesPage: jest.fn(async (offset: number) => offset === 0
      ? { items: [{ id: 1, origin_url: "https://example.com", username: "user", action_url: "", realm: "", date_created: null, date_last_used: null, date_password_changed: null, times_used: 0 }], total: 2 }
      : { items: [{ id: 2, origin_url: "https://second.example", username: "two", action_url: "", realm: "", date_created: null, date_last_used: null, date_password_changed: null, times_used: 0 }], total: 2 }),
    getNeverSaveOriginsPage: jest.fn(async () => ({ items: ["https://blocked.example"], total: 1 })),
    listFormFillValuesPage: jest.fn(async () => ({ items: [], total: 0 })),
    listCookieOriginsPage: jest.fn(async () => ({ items: [], total: 0, revision: 1 })),
    deletePassword: jest.fn(async () => undefined),
    removeNeverSave: jest.fn(async () => undefined),
    addFormFillValue: jest.fn(async () => 1),
    updateFormFillValue: jest.fn(async () => undefined),
    deleteFormFillValue: jest.fn(async () => undefined),
    clearFormFillValues: jest.fn(async () => 0),
    clearCookiesForOrigin: jest.fn(async () => 0),
    clearAllCookies: jest.fn(async () => 0),
    endBrowserSession: jest.fn(async () => 0),
    getCookieSiteSummary: jest.fn(async (origin: string) => ({ origin, cookieCount: 0, revision: 1 })),
    getPasswordCountForSite: jest.fn(async (origin: string) => ({ origin, passwordCount: 0 })),
    ...overrides,
  } as unknown as ShellClient["browserPrivacy"];
}

describe("BrowserPrivacyManager", () => {
  afterEach(() => jest.restoreAllMocks());

  it("opens the requested section, switches an already-mounted manager, and closes explicitly", async () => {
    const client = makeClient();
    const onClose = jest.fn();
    const view = render(
      <BrowserPrivacyManager initialSection="credentials" client={client} onClose={onClose} />
    );
    await waitFor(() => expect(client.listPasswordSummariesPage).toHaveBeenCalledWith(0, 25));

    view.rerender(
      <BrowserPrivacyManager initialSection="debug" client={client} onClose={onClose} />
    );
    await waitFor(() => expect(client.listCookieOriginsPage).toHaveBeenCalledWith(0, 25));
    fireEvent.press(view.getByRole("button", { name: "Close" }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("loads the requested page and paginates password summaries", async () => {
    const client = makeClient();
    const view = render(
      <BrowserPrivacyManager initialSection="credentials" client={client} onClose={jest.fn()} />
    );

    await waitFor(() => expect(view.getByText("https://example.com")).toBeTruthy());
    fireEvent.press(view.getByText("Load more passwords"));
    await waitFor(() => expect(view.getByText("https://second.example")).toBeTruthy());

    expect(client.listPasswordSummariesPage).toHaveBeenNthCalledWith(1, 0, 25);
    expect(client.listPasswordSummariesPage).toHaveBeenNthCalledWith(2, 1, 25);
  });

  it("paginates never-save rules independently from password rows", async () => {
    const getNeverSaveOriginsPage = jest.fn(async (offset: number) => offset === 0
      ? { items: ["https://blocked.example"], total: 2 }
      : { items: ["https://another-blocked.example"], total: 2 });
    const client = makeClient({ getNeverSaveOriginsPage });
    const view = render(
      <BrowserPrivacyManager initialSection="credentials" client={client} onClose={jest.fn()} />
    );
    await waitFor(() => expect(view.getByText("https://blocked.example")).toBeTruthy());

    fireEvent.press(view.getByText("Load more never-save rules"));

    await waitFor(() => expect(view.getByText("https://another-blocked.example")).toBeTruthy());
    expect(getNeverSaveOriginsPage).toHaveBeenNthCalledWith(2, 1, 25);
  });

  it("confirms deletion, mutates through the trusted service, and refreshes", async () => {
    const client = makeClient();
    jest.spyOn(Alert, "alert").mockImplementation((_title, _message, buttons) => {
      buttons?.find((button) => button.text === "Continue")?.onPress?.();
    });
    const view = render(
      <BrowserPrivacyManager initialSection="credentials" client={client} onClose={jest.fn()} />
    );
    await waitFor(() => expect(view.getByText("https://example.com")).toBeTruthy());

    fireEvent.press(view.getAllByText("Delete")[0]!);

    await waitFor(() => expect(client.deletePassword).toHaveBeenCalledWith(1));
    expect(client.listPasswordSummariesPage).toHaveBeenCalledTimes(2);
    expect(view.getByText("Saved password deleted.")).toBeTruthy();
  });

  it("supports protected-only form-fill management without a panel round trip", async () => {
    const client = makeClient();
    const view = render(
      <BrowserPrivacyManager initialSection="formFill" client={client} onClose={jest.fn()} />
    );
    await waitFor(() => expect(client.listFormFillValuesPage).toHaveBeenCalledWith(0, 25));

    fireEvent.changeText(view.getByLabelText("Field name"), "email");
    fireEvent.changeText(view.getByLabelText("Type (optional)"), "email");
    fireEvent.changeText(view.getByLabelText("Value"), "person@example.com");
    fireEvent.press(view.getByText("Add value"));

    await waitFor(() => expect(client.addFormFillValue).toHaveBeenCalledWith({
      fieldName: "email",
      type: "email",
      value: "person@example.com",
    }));
    expect(view.getByText("Form-fill value saved.")).toBeTruthy();
  });

  it("edits, deletes, clears, and paginates form-fill values through the trusted service", async () => {
    const row = {
      id: 7,
      fieldName: "email",
      type: "email" as const,
      value: "old@example.com",
      displayLabel: "Old label",
      aliases: [],
      createdAt: 1,
      updatedAt: 1,
      useCount: 0,
    };
    const listFormFillValuesPage = jest.fn(async (offset: number) => offset === 0
      ? { items: [row], total: 2 }
      : { items: [{ ...row, id: 8, value: "next@example.com" }], total: 2 });
    const client = makeClient({ listFormFillValuesPage });
    jest.spyOn(Alert, "alert").mockImplementation((_title, _message, buttons) => {
      buttons?.find((button) => button.text === "Continue")?.onPress?.();
    });
    const view = render(
      <BrowserPrivacyManager initialSection="formFill" client={client} onClose={jest.fn()} />
    );
    await waitFor(() => expect(view.getByText("old@example.com")).toBeTruthy());

    fireEvent.press(view.getByText("Load more form-fill values"));
    await waitFor(() => expect(view.getByText("next@example.com")).toBeTruthy());
    expect(listFormFillValuesPage).toHaveBeenNthCalledWith(2, 1, 25);

    fireEvent.press(view.getAllByText("Edit")[0]!);
    fireEvent.changeText(view.getByLabelText("Value"), "new@example.com");
    fireEvent.changeText(view.getByLabelText("Label (optional)"), "");
    fireEvent.press(view.getByText("Save changes"));
    await waitFor(() => expect(client.updateFormFillValue).toHaveBeenCalledWith(7, {
      value: "new@example.com",
      displayLabel: "",
    }));

    fireEvent.press(view.getAllByText("Delete")[0]!);
    await waitFor(() => expect(client.deleteFormFillValue).toHaveBeenCalledWith(7));
    fireEvent.press(view.getByText("Clear all"));
    await waitFor(() => expect(client.clearFormFillValues).toHaveBeenCalledTimes(1));
  });

  it("paginates cookie origins and confirms session-wide mutations", async () => {
    const listCookieOriginsPage = jest.fn(async (offset: number) => offset === 0
      ? { items: ["https://one.example"], total: 2, revision: 4 }
      : { items: ["https://two.example"], total: 2, revision: 4 });
    const client = makeClient({ listCookieOriginsPage });
    jest.spyOn(Alert, "alert").mockImplementation((_title, _message, buttons) => {
      buttons?.find((button) => button.text === "Continue")?.onPress?.();
    });
    const view = render(
      <BrowserPrivacyManager initialSection="debug" client={client} onClose={jest.fn()} />
    );
    await waitFor(() => expect(view.getByText("https://one.example")).toBeTruthy());

    fireEvent.press(view.getByText("Load more cookie origins"));
    await waitFor(() => expect(view.getByText("https://two.example")).toBeTruthy());
    expect(listCookieOriginsPage).toHaveBeenNthCalledWith(2, 1, 25);

    fireEvent.press(view.getByText("End session"));
    await waitFor(() => expect(client.endBrowserSession).toHaveBeenCalledTimes(1));
    fireEvent.press(view.getByText("Clear all cookies"));
    await waitFor(() => expect(client.clearAllCookies).toHaveBeenCalledTimes(1));
  });

  it("renders service failures as an accessible error", async () => {
    const client = makeClient({
      getCookieSiteSummary: jest.fn(async () => { throw new Error("Privacy service unavailable"); }),
    });
    const view = render(
      <BrowserPrivacyManager initialSection="inspect" client={client} onClose={jest.fn()} />
    );
    await waitFor(() => expect(
      view.getByRole("button", { name: "Inspect site data" }).props.accessibilityState.disabled
    ).toBe(false));
    fireEvent.changeText(view.getByLabelText("Site URL or origin"), "https://example.com");
    fireEvent.press(view.getByRole("button", { name: "Inspect site data" }));

    await waitFor(() => expect(view.getByText("Privacy service unavailable")).toBeTruthy());
  });

  it("normalizes a site name to one exact HTTPS origin", async () => {
    const client = makeClient();
    const view = render(
      <BrowserPrivacyManager initialSection="inspect" client={client} onClose={jest.fn()} />
    );
    await waitFor(() => expect(
      view.getByRole("button", { name: "Inspect site data" }).props.accessibilityState.disabled
    ).toBe(false));
    fireEvent.changeText(view.getByLabelText("Site URL or origin"), "example.com/account");
    fireEvent.press(view.getByRole("button", { name: "Inspect site data" }));

    await waitFor(() => expect(client.getCookieSiteSummary).toHaveBeenCalledWith("https://example.com"));
    expect(client.getPasswordCountForSite).toHaveBeenCalledWith("https://example.com");
  });
});
