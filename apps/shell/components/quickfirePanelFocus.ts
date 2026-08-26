export interface FocusRestoreSlot {
  current: Promise<void> | null;
}

/**
 * Serialize overlay context acquisition behind dismissal's focus restoration.
 * The overlay itself owns both operations, so callers need no timing guesses.
 */
export async function acquireFocusedPanelIdAfterRestore(
  restore: FocusRestoreSlot,
  getFocusedPanelId: () => Promise<string | null>,
): Promise<string | null> {
  const pending = restore.current;
  if (pending) {
    await pending;
    if (restore.current === pending) restore.current = null;
  }
  return getFocusedPanelId();
}
