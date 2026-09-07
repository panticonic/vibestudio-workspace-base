/** Runtime directory names remain opaque; private roles have familiar UI names. */
export function workspaceName(entry: {
  name: string;
  privateRole?: "personal" | "system";
}): string {
  return entry.privateRole === "personal"
    ? "Personal"
    : entry.privateRole === "system"
      ? "System"
      : entry.name;
}
