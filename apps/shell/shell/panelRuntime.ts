import {
  createPanelRuntime,
  type CreatePanelRuntimeOptions,
  type PanelRuntimeApi,
} from "@workspace/runtime/panel-runtime";

type ShellPanelRuntimeOptions = Pick<
  CreatePanelRuntimeOptions,
  "rpc" | "focusPanel"
>;

/** Bind product panel handles to the native shell presentation host. */
export function createShellPanelRuntime(
  options: ShellPanelRuntimeOptions,
): PanelRuntimeApi {
  return createPanelRuntime({
    rpc: options.rpc,
    focusPanel: options.focusPanel,
  });
}
