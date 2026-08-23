import { useEffect, useRef, useState } from "react";

interface SearchInputProps {
  placeholder?: string;
  debounceMs?: number;
  onSearch: (keyword: string) => void;
}

/** 搜索框：内置防抖（默认 300ms，对应架构 §4 搜索流程） */
export default function SearchInput({ placeholder = "搜索标签 / 文件名…", debounceMs = 300, onSearch }: SearchInputProps) {
  const [value, setValue] = useState("");
  // F18：挂载时（或 onSearch 引用变化导致 effect 重启时）不得把初始空值提交上去——
  // 否则页面刚加载/顶栏重渲染后会误发 setFilter({search:""})，触发 B09 清空选中
  const mounted = useRef(false);

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    const timer = setTimeout(() => onSearch(value.trim()), debounceMs);
    return () => clearTimeout(timer);
  }, [value, debounceMs, onSearch]);

  return (
    <input
      type="search"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      placeholder={placeholder}
      className="w-64 px-3 py-1.5 text-sm rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] outline-none focus:border-[var(--color-accent)] placeholder:text-[var(--color-text-secondary)]"
    />
  );
}
