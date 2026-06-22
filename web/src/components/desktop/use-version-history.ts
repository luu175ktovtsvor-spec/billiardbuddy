"use client";

/**
 * 版本检查点：给画板里每一版改动存档，能回看/跳到任意一版（对齐 Cursor checkpoints /
 * Claude Artifacts 版本历史）。本次打开内有效（换预览对象时 reset 清空）。
 * 通用于"单值演进"的编辑面——文案(string)、网页(string)、Word/PPT(改动 map) 都可复用。
 */
import { useCallback, useMemo, useState } from "react";

export interface Version<T> {
  value: T;
  label: string;
}

export interface VersionHistory<T> {
  current: T;
  versions: Version<T>[];
  index: number;
  /** 提交新一版（与当前版相同则忽略；会截断当前版之后的"重做"分支）。 */
  commit: (value: T, label: string) => void;
  /** 跳到第 i 版。 */
  goto: (i: number) => void;
  /** 重置时间线（换了预览对象 / 写回后定新基线）。 */
  reset: (value: T, label?: string) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

export function useVersionHistory<T>(initial: T, initialLabel = "最初", eq?: (a: T, b: T) => boolean): VersionHistory<T> {
  const [state, setState] = useState<{ versions: Version<T>[]; index: number }>({
    versions: [{ value: initial, label: initialLabel }],
    index: 0,
  });

  const commit = useCallback((value: T, label: string) => {
    const same = eq || ((a: T, b: T) => a === b);
    setState((s) => {
      if (same(value, s.versions[s.index].value)) return s; // 没变化不存
      const base = s.versions.slice(0, s.index + 1);          // 截断"重做"分支
      const versions = [...base, { value, label }];
      return { versions, index: versions.length - 1 };
    });
  }, [eq]);

  const goto = useCallback((i: number) => {
    setState((s) => ({ ...s, index: Math.max(0, Math.min(i, s.versions.length - 1)) }));
  }, []);

  const reset = useCallback((value: T, label = "最初") => {
    setState({ versions: [{ value, label }], index: 0 });
  }, []);

  const undo = useCallback(() => setState((s) => ({ ...s, index: Math.max(0, s.index - 1) })), []);
  const redo = useCallback(() => setState((s) => ({ ...s, index: Math.min(s.versions.length - 1, s.index + 1) })), []);

  return useMemo(() => ({
    current: state.versions[state.index].value,
    versions: state.versions,
    index: state.index,
    commit,
    goto,
    reset,
    undo,
    redo,
    canUndo: state.index > 0,
    canRedo: state.index < state.versions.length - 1,
  }), [state, commit, goto, reset, undo, redo]);
}
