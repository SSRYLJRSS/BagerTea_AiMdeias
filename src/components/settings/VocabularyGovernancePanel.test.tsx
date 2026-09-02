/**
 * F6-d：词表治理面板 —— 新词待确认（三动作）+ 疑似重复组（合并到所选）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import VocabularyGovernancePanel from "@/components/settings/VocabularyGovernancePanel";

const aiMocks = vi.hoisted(() => ({
  aiListNewWordCandidates: vi.fn(),
  aiDecideSuggestionItem: vi.fn(),
}));
const tagsMocks = vi.hoisted(() => ({
  scanDuplicateTags: vi.fn(),
  searchTagCandidates: vi.fn(),
  mergeTags: vi.fn(),
}));
vi.mock("@/api/ai", () => ({
  aiListNewWordCandidates: aiMocks.aiListNewWordCandidates,
  aiDecideSuggestionItem: aiMocks.aiDecideSuggestionItem,
}));
vi.mock("@/api/tags", () => ({
  scanDuplicateTags: tagsMocks.scanDuplicateTags,
  searchTagCandidates: tagsMocks.searchTagCandidates,
  mergeTags: tagsMocks.mergeTags,
}));

const CANDIDATE = {
  id: 11,
  suggestionId: 3,
  assetId: 1,
  facetKey: "scene",
  rawName: "太空漫步",
  normalizedName: "太空漫步",
  tagId: null,
  confidence: 0.91,
  decision: "pending",
  decisionReason: "疑似与「星空」重复",
  createdAt: 1,
};

const TAG_SINGLE = {
  id: 1, name: "星空", canonicalName: "星空", normalizedName: "星空", facetKey: "scene",
  parentId: null, status: "active" as const, isSystem: false, isPreset: false,
  sortOrder: 0, assetCount: 1, totalCount: 1, aliases: [], path: "星空", facetEffective: true,
};

describe("VocabularyGovernancePanel (F6-d)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    aiMocks.aiListNewWordCandidates.mockResolvedValue([CANDIDATE]);
    tagsMocks.scanDuplicateTags.mockResolvedValue([
      { facetKey: "scene", members: [
        { tagId: 7, name: "单人", assetCount: 5 },
        { tagId: 8, name: "一个人", assetCount: 1 },
      ] },
    ]);
    tagsMocks.searchTagCandidates.mockResolvedValue([TAG_SINGLE]);
    tagsMocks.mergeTags.mockResolvedValue(undefined);
    aiMocks.aiDecideSuggestionItem.mockResolvedValue(undefined);
  });

  it("new_word_candidates_listed_with_similar_hint", async () => {
    render(<VocabularyGovernancePanel />);
    await waitFor(() =>
      expect(screen.getByText(/新词待确认（1）/)).toBeInTheDocument(),
    );
    expect(screen.getByText(/「太空漫步」/)).toBeInTheDocument();
    expect(screen.getByText(/疑似与「星空」重复/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "采纳为正式词" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "拒绝" })).toBeInTheDocument();
  });

  it("accept_creates_tag_via_decide", async () => {
    render(<VocabularyGovernancePanel />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "采纳为正式词" })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "采纳为正式词" }));
    await waitFor(() => expect(aiMocks.aiDecideSuggestionItem).toHaveBeenCalled());
    expect(aiMocks.aiDecideSuggestionItem).toHaveBeenCalledWith(11, "accepted", null, "太空漫步");
  });

  it("duplicate_group_merge_targets_selected", async () => {
    render(<VocabularyGovernancePanel />);
    await waitFor(() =>
      expect(screen.getByText(/疑似重复（1 组）/)).toBeInTheDocument(),
    );
    // 组内默认目标是首成员「单人」；点组行的「合并到所选」把其余并入
    //（[0] 是候选行按钮——未选目标时禁用；[1] 是疑似重复组的合并按钮）
    const mergeBtn = screen.getAllByRole("button", { name: "合并到所选" })[1];
    fireEvent.click(mergeBtn);
    await waitFor(() => expect(tagsMocks.mergeTags).toHaveBeenCalled());
    expect(tagsMocks.mergeTags).toHaveBeenCalledWith(8, 7);
  });
});
