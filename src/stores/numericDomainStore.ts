/** Phase 4（§5.3）：数值字段 NumericDomain 单一事实源的 store（照 metadataStore 写法）。
 *  QueryBuilder 的 ValueInput / between 校验全部消费本 store，不再各自维护一套魔法数。 */
import { create } from "zustand";
import { getNumericDomains } from "@/api/assets";
import type { NumericDomain } from "@/types/asset";

interface NumericDomainState {
  domains: NumericDomain[];
  loading: boolean;
  loaded: boolean;
  refresh: () => Promise<void>;
}

export const useNumericDomainStore = create<NumericDomainState>((set) => ({
  domains: [],
  loading: false,
  loaded: false,
  refresh: async () => {
    set({ loading: true });
    try {
      set({ domains: await getNumericDomains(), loading: false, loaded: true });
    } catch {
      set({ loading: false, loaded: true });
    }
  },
}));
