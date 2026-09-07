import { render, fireEvent, waitFor } from "@testing-library/react-native";
import { WorkspaceTransferSheet } from "./WorkspaceTransferSheet";
import {
  listTransferFiles,
  prepareMobileTransfer,
} from "../services/workspaceFileTransfer";
import type { MobileWorkspaceDirectory } from "../services/workspaceDirectory";

jest.mock("../services/workspaceFileTransfer", () => ({
  listTransferFiles: jest.fn(),
  prepareMobileTransfer: jest.fn(),
  moreTransferFiles: jest.fn(),
}));

it.each([false, true])(
  "reviews exact selected files and handles an interrupted attempt (%s)",
  async (fails) => {
    const execute = jest.fn(async () => {
      if (fails) throw new Error("Connection lost");
    });
    const reviewWithAgent = jest.fn(async () => undefined);
    jest.mocked(listTransferFiles).mockResolvedValue({
      state: { kind: "event", eventId: "source-main" },
      repositoryId: "repo",
      files: [{ path: "README.md" }, { path: "private.txt" }],
      nextCursor: null,
    } as never);
    jest.mocked(prepareMobileTransfer).mockResolvedValue({
      contextId: "review",
      reviewAvailable: true,
      execute,
      reviewWithAgent,
      preview: {
        sourceLabel: "Personal",
        destinationLabel: "Research",
        destinationRepoPath: "panels/shared",
        audience: ["Alice", "Bob"],
        totalBytes: 42,
        files: [
          { sourcePath: "README.md", destinationPath: "README.md", size: 42 },
        ],
      },
    } as never);
    const directory = {
      entries: [
        { workspaceId: "personal", name: "Personal" },
        { workspaceId: "research", name: "Research" },
      ],
    } as MobileWorkspaceDirectory;
    const close = jest.fn();
    const view = render(
      <WorkspaceTransferSheet
        directory={directory}
        initialWorkspaceId="personal"
        onClose={close}
      />,
    );
    fireEvent.changeText(
      view.getByLabelText("Source repository path"),
      "panels/private",
    );
    fireEvent.press(view.getByText("Choose files"));
    await waitFor(() => expect(view.getByText("README.md")).toBeTruthy());
    fireEvent.press(view.getByText("README.md"));
    fireEvent.press(view.getAllByText("Research")[1]!);
    fireEvent.changeText(
      view.getByLabelText("Destination repository path"),
      "panels/shared",
    );
    fireEvent.press(view.getByText("Review copy"));
    await waitFor(() =>
      expect(view.getByText("Personal → Research")).toBeTruthy(),
    );
    expect(prepareMobileTransfer).toHaveBeenCalledWith(
      directory,
      expect.objectContaining({
        paths: ["README.md"],
        targetWorkspaceId: "research",
      }),
    );
    expect(execute).not.toHaveBeenCalled();
    expect(view.getByText(/Alice, Bob/)).toBeTruthy();
    fireEvent.press(view.getByText("Copy to review branch"));
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    expect(reviewWithAgent).not.toHaveBeenCalled();
    if (fails) {
      await waitFor(() =>
        expect(view.getByText(/Some selected files may already/)).toBeTruthy(),
      );
      expect(view.queryByText("Copy to review branch")).toBeNull();
      expect(view.getByText("Make a fresh review")).toBeTruthy();
    }
    fireEvent.press(
      view.getByText(
        fails ? "Check review branch with agent" : "Review with agent",
      ),
    );
    await waitFor(() => expect(reviewWithAgent).toHaveBeenCalledTimes(1));
    expect(close).toHaveBeenCalled();
  },
);
