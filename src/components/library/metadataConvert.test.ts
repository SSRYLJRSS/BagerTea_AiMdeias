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

  it("主要颜色使用前三色索引并应用 10% 门槛", () => {
    expect(bucketToFilter("palette_top3", "蓝")).toEqual({
      key: "palette_top3",
      op: "eq",
      value: "蓝",
      min: 0.1,
    });
  });
});
