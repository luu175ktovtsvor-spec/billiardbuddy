/** 识别 AI 产出里"需要用户补充"的占位符（#2）。
 * - 方括号 [...]：本应用约定的占位写法（如 [请补充：XX元]、[请填写]）
 * - 全角【...】：仅当含"请填写/请补充/待填/待补充"才算占位，
 *   避免误伤【方案一】【篇幅要求】这类正常标题
 * 返回去重后的占位符原文（保留首次出现顺序）。 */
export function findPlaceholders(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (m: string) => {
    if (!seen.has(m)) {
      seen.add(m);
      out.push(m);
    }
  };
  for (const m of text.matchAll(/\[[^\]\n]{1,40}\]/g)) push(m[0]);
  for (const m of text.matchAll(/【[^】\n]{0,40}(?:请填写|请补充|待填|待补充)[^】\n]{0,40}】/g)) push(m[0]);
  return out;
}
