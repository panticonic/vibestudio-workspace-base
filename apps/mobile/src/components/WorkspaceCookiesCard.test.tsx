import { render, fireEvent, waitFor } from "@testing-library/react-native";
import { Provider, createStore } from "jotai";
import { WorkspaceCookiesCard } from "./WorkspaceCookiesCard";
import { ActionSheetHost } from "./ui/ActionSheetHost";

it("requires explicit review before clearing the captured device workspace cookies", async () => {
  const clear = jest.fn(async () => undefined);
  const view = render(
    <Provider store={createStore()}>
      <WorkspaceCookiesCard workspaceName="Research" onClear={clear} />
      <ActionSheetHost />
    </Provider>,
  );
  fireEvent.press(view.getByText("Clear website cookies"));
  expect(clear).not.toHaveBeenCalled();
  expect(view.getByText("Research · Clear website cookies?")).toBeTruthy();
  fireEvent.press(view.getByText("Clear cookies"));
  await waitFor(() => expect(clear).toHaveBeenCalledTimes(1));
  expect(view.getByText("Website cookies cleared for Research.")).toBeTruthy();
});
