import { describe, expect, it } from "vitest";
import {
  CHANNEL_DELIVERY_LATENCY_BASELINE_MS,
  channelDeliveryLatencyViolations,
  summarizeChannelDeliveryLatency,
} from "./delivery-latency.js";

describe("channel delivery latency regression gate", () => {
  it("fails only metrics whose observed execution span exceeds the checked-in baseline", () => {
    const metric = "publish-to-recipient-execution";
    expect(
      channelDeliveryLatencyViolations({
        channelDelivery: {
          deliveryLifecycle: {
            latencyHistogram: [
              {
                metric,
                maximum_ms: CHANNEL_DELIVERY_LATENCY_BASELINE_MS[metric] + 1,
              },
              { metric: "call-to-provider-execution", maximum_ms: 20 },
            ],
          },
        },
      })
    ).toEqual([expect.stringContaining(metric)]);
  });

  it("fails closed when collected channel latency diagnostics are malformed", () => {
    expect(
      channelDeliveryLatencyViolations({ channelDelivery: { deliveryLifecycle: {} } })
    ).toEqual([expect.stringContaining("unavailable")]);
    expect(
      channelDeliveryLatencyViolations({
        channelDelivery: {
          deliveryLifecycle: {
            latencyHistogram: [{ metric: "call-to-provider-execution", maximum_ms: Number.NaN }],
          },
        },
      })
    ).toEqual([expect.stringContaining("invalid maximum_ms")]);
  });
});

describe("channel delivery latency summary", () => {
  it("separates a single over-budget outlier from the bulk of the distribution", () => {
    const summary = summarizeChannelDeliveryLatency({
      channelDelivery: {
        deliveryLifecycle: {
          latencyHistogram: [
            {
              metric: "publish-to-recipient-execution",
              upper_bound_ms: 30000,
              samples: 1,
              maximum_ms: 30001,
            },
            {
              metric: "publish-to-recipient-execution",
              upper_bound_ms: 100,
              samples: 9,
              maximum_ms: 80,
            },
          ],
        },
      },
    });

    expect(summary?.violations).toHaveLength(1);
    expect(summary?.metrics).toEqual([
      {
        metric: "publish-to-recipient-execution",
        budgetMs: CHANNEL_DELIVERY_LATENCY_BASELINE_MS["publish-to-recipient-execution"],
        maximumMs: 30001,
        samples: 10,
        overBudget: true,
        buckets: [
          { upperBoundMs: 100, samples: 9, maximumMs: 80 },
          { upperBoundMs: 30000, samples: 1, maximumMs: 30001 },
        ],
      },
    ]);
  });

  it("reports the fail-closed violation even when no row survives projection", () => {
    const summary = summarizeChannelDeliveryLatency({
      channelDelivery: { deliveryLifecycle: {} },
    });
    expect(summary?.metrics).toEqual([]);
    expect(summary?.violations).toEqual([expect.stringContaining("unavailable")]);
  });

  it("is absent when channel delivery diagnostics were never collected", () => {
    expect(summarizeChannelDeliveryLatency(undefined)).toBeNull();
    expect(summarizeChannelDeliveryLatency({})).toBeNull();
  });
});
