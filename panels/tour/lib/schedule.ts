/** Cadence helpers for the automations scene: a cadence → cron → next runs. */

export type CadenceUnit = "minutes" | "hours" | "days";

export interface Cadence {
  every: number;
  unit: CadenceUnit;
  /** Hour of day for daily cadences (0–23). */
  atHour: number;
}

export function cadenceToCron(cadence: Cadence): string {
  switch (cadence.unit) {
    case "minutes":
      return cadence.every === 1 ? "* * * * *" : `*/${cadence.every} * * * *`;
    case "hours":
      return cadence.every === 1 ? "0 * * * *" : `0 */${cadence.every} * * *`;
    case "days":
      return cadence.every === 1
        ? `0 ${cadence.atHour} * * *`
        : `0 ${cadence.atHour} */${cadence.every} * *`;
  }
}

/** The next `count` firing times after `from`, matching `cadenceToCron`'s semantics. */
export function nextRuns(cadence: Cadence, from: Date, count: number): Date[] {
  const runs: Date[] = [];
  const cursor = new Date(from.getTime());
  cursor.setSeconds(0, 0);
  // Step one minute at a time; cadences are coarse so this is cheap.
  const limit = 60 * 24 * 62; // two months of minutes
  for (let i = 0; i < limit && runs.length < count; i++) {
    cursor.setMinutes(cursor.getMinutes() + 1);
    if (matches(cadence, cursor)) runs.push(new Date(cursor.getTime()));
  }
  return runs;
}

function matches(cadence: Cadence, date: Date): boolean {
  const minute = date.getMinutes();
  const hour = date.getHours();
  const day = date.getDate();
  switch (cadence.unit) {
    case "minutes":
      return minute % cadence.every === 0;
    case "hours":
      return minute === 0 && hour % cadence.every === 0;
    case "days":
      return minute === 0 && hour === cadence.atHour && (day - 1) % cadence.every === 0;
  }
}

export function describeCadence(cadence: Cadence): string {
  const unit = cadence.unit.slice(0, -1);
  const every = cadence.every === 1 ? `every ${unit}` : `every ${cadence.every} ${cadence.unit}`;
  if (cadence.unit === "days") {
    const hh = String(cadence.atHour).padStart(2, "0");
    return `${every} at ${hh}:00`;
  }
  return every;
}
