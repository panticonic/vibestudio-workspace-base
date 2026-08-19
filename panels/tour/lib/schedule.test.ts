import { describe, expect, it } from "vitest";
import { cadenceToCron, describeCadence, nextRuns } from "./schedule";
import { clampToStep } from "./Tangle";

describe("cadence helpers", () => {
  it("renders cron for each unit", () => {
    expect(cadenceToCron({ every: 1, unit: "minutes", atHour: 9 })).toBe("* * * * *");
    expect(cadenceToCron({ every: 15, unit: "minutes", atHour: 9 })).toBe("*/15 * * * *");
    expect(cadenceToCron({ every: 6, unit: "hours", atHour: 9 })).toBe("0 */6 * * *");
    expect(cadenceToCron({ every: 1, unit: "days", atHour: 7 })).toBe("0 7 * * *");
    expect(cadenceToCron({ every: 3, unit: "days", atHour: 7 })).toBe("0 7 */3 * *");
  });

  it("computes upcoming runs consistent with the cron", () => {
    const from = new Date(2026, 0, 1, 10, 17); // local time
    const runs = nextRuns({ every: 6, unit: "hours", atHour: 9 }, from, 3);
    expect(runs.map((d) => [d.getHours(), d.getMinutes()])).toEqual([
      [12, 0],
      [18, 0],
      [0, 0],
    ]);
    const daily = nextRuns({ every: 1, unit: "days", atHour: 9 }, from, 2);
    expect(daily[0]?.getDate()).toBe(2);
    expect(daily[0]?.getHours()).toBe(9);
    expect(daily[1]?.getDate()).toBe(3);
  });

  it("describes cadences for prose", () => {
    expect(describeCadence({ every: 1, unit: "hours", atHour: 0 })).toBe("every hour");
    expect(describeCadence({ every: 2, unit: "days", atHour: 7 })).toBe("every 2 days at 07:00");
  });
});

describe("clampToStep", () => {
  it("snaps to the step grid inside the range", () => {
    expect(clampToStep(7, 0, 10, 5)).toBe(5);
    expect(clampToStep(-3, 0, 10, 1)).toBe(0);
    expect(clampToStep(12, 0, 10, 1)).toBe(10);
    expect(clampToStep(0.26, 0, 1, 0.1)).toBe(0.3);
  });
});
