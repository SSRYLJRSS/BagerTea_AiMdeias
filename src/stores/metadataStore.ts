import { create } from "zustand";
import { listMetadataFacets } from "@/api/assets";
import type { MetadataFacet } from "@/types/asset";

interface MetadataState {
  facets: MetadataFacet[];
  loading: boolean;
  loaded: boolean;
  refresh: () => Promise<void>;
}

export const useMetadataStore = create<MetadataState>((set) => ({
  facets: [],
  loading: false,
  loaded: false,
  refresh: async () => {
    set({ loading: true });
    try {
      set({ facets: await listMetadataFacets(), loading: false, loaded: true });
    } catch {
      set({ loading: false, loaded: true });
    }
  },
}));
