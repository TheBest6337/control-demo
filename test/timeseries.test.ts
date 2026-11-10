// ui/src/lib/timeseries.ts is replaced by an O(1) insert (see ui-patches.md).
// It must keep upstream's results and never touch a series' initial state,
// which every store created from it shares.

import { produce } from "immer";
import { describe, expect, it } from "vitest";
import {
  createTimeSeries,
  extractDataFromSeries,
  type TimeSeries,
  type TimeSeriesValue,
} from "@/lib/timeseries";

/** Upstream's insert (immer), for comparison. */
function upstreamInsert(series: TimeSeries, value: TimeSeriesValue) {
  return produce(series, (draft) => {
    draft.current = value;
    for (const s of [draft.short, draft.long]) {
      if (value.timestamp - s.lastTimestamp >= s.sampleInterval) {
        const old = s.values[s.index];
        s.values[s.index] = value;
        s.index = (s.index + 1) % s.size;
        s.lastTimestamp = value.timestamp;
        if (!(old && old.timestamp > 0)) s.validCount++;
      }
    }
  });
}

const config = {
  sampleIntervalShort: 20,
  sampleIntervalLong: 1000,
  retentionDurationShort: 200,
  retentionDurationLong: 10_000,
};

describe("timeseries insert", () => {
  it("matches upstream, including wrap-around", () => {
    const { initialTimeSeries, insert } = createTimeSeries(config);
    let a = initialTimeSeries;
    let b = initialTimeSeries;
    for (let i = 1; i <= 500; i++) {
      const v = { value: Math.sin(i), timestamp: 1_000_000 + i * 70 };
      a = insert(a, v);
      b = upstreamInsert(b, v);
      if (i % 37 === 0) {
        for (const k of ["short", "long"] as const) {
          expect(extractDataFromSeries(a[k])).toEqual(
            extractDataFromSeries(b[k]),
          );
          expect(a[k].validCount).toBe(b[k].validCount);
          expect(a[k].index).toBe(b[k].index);
        }
      }
    }
    expect(a.current).toEqual(b.current);
  });

  it("returns new objects and leaves the shared initial state alone", () => {
    const { initialTimeSeries, insert } = createTimeSeries(config);
    const before = JSON.stringify(initialTimeSeries);
    const s1 = insert(initialTimeSeries, { value: 1, timestamp: 5000 });
    const s2 = insert(s1, { value: 2, timestamp: 6000 });
    expect(s2).not.toBe(s1);
    expect(s2.long).not.toBe(s1.long);
    expect(JSON.stringify(initialTimeSeries)).toBe(before);
    // a second store starting from the same initial state is independent
    const other = insert(initialTimeSeries, { value: 9, timestamp: 5000 });
    expect(extractDataFromSeries(other.long)[1]).toEqual([9]);
    expect(extractDataFromSeries(s2.long)[1]).toEqual([1, 2]);
  });

  it("copies a buffer that immer froze elsewhere", () => {
    const { initialTimeSeries, insert } = createTimeSeries(config);
    const s1 = insert(initialTimeSeries, { value: 1, timestamp: 5000 });
    const frozen = produce({ s: s1 }, (d) => {
      d.s.current = { value: 1, timestamp: 5000 };
    }).s;
    expect(Object.isFrozen(frozen.long.values)).toBe(true);
    const s2 = insert(frozen, { value: 2, timestamp: 6000 });
    expect(extractDataFromSeries(s2.long)[1]).toEqual([1, 2]);
  });
});
