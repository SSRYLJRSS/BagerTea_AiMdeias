import { describe, expect, it } from "vitest";
import { bucketToFilter } from "@/components/library/metadataConvert";

describe("metadataConvert", () => {
  it("月份分面覆盖整个月，不把次月 1 日算进去", () => {
    expect(bucketToFilter("taken_month", "2025-02")).toEqual({
      key: "taken_at",
      op: "between",
      min: "2025-02-01",
      max: "2025-02-28",
    });
  });
});
