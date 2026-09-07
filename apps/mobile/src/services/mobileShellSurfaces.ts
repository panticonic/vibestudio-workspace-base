import {
  validateShellSurfaceTarget,
  type ShellSurfaceDescriptor,
  type SettingsSection,
} from "@vibestudio/shared/shellSurface";

export const MOBILE_SHELL_SURFACES = ["settings", "workspace-chooser"] as const;
export const MOBILE_SETTINGS_SECTIONS: readonly SettingsSection[] = [
  "connection",
  "devices",
  "profile",
  "appearance",
  "workspaces",
];
export type MobileShellSurface = Extract<
  ShellSurfaceDescriptor,
  {
    kind: (typeof MOBILE_SHELL_SURFACES)[number];
  }
>;

/** Opening native chrome grants no access to its data or privileged actions. */
export function mobileShellSurface(target: unknown): MobileShellSurface {
  const descriptor = validateShellSurfaceTarget(target);
  if (
    descriptor.kind !== "settings" &&
    descriptor.kind !== "workspace-chooser"
  ) {
    throw new Error(
      `Mobile cannot open the "${descriptor.kind}" shell surface`,
    );
  }
  if (
    descriptor.kind === "settings" &&
    descriptor.section &&
    !MOBILE_SETTINGS_SECTIONS.includes(descriptor.section)
  ) {
    throw new Error(`Mobile settings do not include "${descriptor.section}"`);
  }
  return descriptor;
}
