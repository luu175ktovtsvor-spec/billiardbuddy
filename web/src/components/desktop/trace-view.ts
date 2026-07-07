export interface TracePreparedLine<Phase extends string> {
  text: string;
  phase: Phase;
  phaseLabel: string;
  haystack: string;
}

export interface TracePhaseRange<Phase extends string> {
  phase: Phase;
  phaseLabel: string;
  count: number;
  start: number;
  end: number;
}

export interface TraceWindowOptions {
  maxLines?: number;
  query?: string;
}

export interface TraceWindowResult<OutLine extends { text: string }, Phase extends string> {
  lines: string[];
  lineViews: OutLine[];
  phaseGroups: TracePhaseRange<Phase>[];
  totalLines: number;
  matchCount: number;
  hiddenLines: number;
  hasQuery: boolean;
}

export function normalizeTraceSearchText(value: string): string {
  return value.toLocaleLowerCase("zh-CN");
}

export function buildTraceWindow<PreparedLine extends TracePreparedLine<Phase>, OutLine extends { text: string }, Phase extends string>(
  allLines: PreparedLine[],
  opts: TraceWindowOptions,
  config: {
    defaultMaxLines: number;
    start(line: PreparedLine): number;
    end(line: PreparedLine): number;
    toLine(line: PreparedLine): OutLine;
    foldedLine(hiddenLines: number): OutLine;
  },
): TraceWindowResult<OutLine, Phase> {
  const terms = (opts.query || "")
    .trim()
    .split(/\s+/)
    .map((term) => normalizeTraceSearchText(term))
    .filter(Boolean);
  const hasQuery = terms.length > 0;
  const matchedLines = hasQuery
    ? allLines.filter((line) => terms.every((term) => line.haystack.includes(term)))
    : allLines;
  const maxLines = opts.maxLines ?? config.defaultMaxLines;
  const hiddenLines = maxLines > 0 && matchedLines.length > maxLines ? matchedLines.length - maxLines : 0;
  const visibleLines = hiddenLines > 0 ? matchedLines.slice(-maxLines) : matchedLines;
  const lineViews = hiddenLines > 0
    ? [config.foldedLine(hiddenLines), ...visibleLines.map(config.toLine)]
    : visibleLines.map(config.toLine);

  return {
    lines: lineViews.map((line) => line.text),
    lineViews,
    phaseGroups: buildTracePhaseGroups(matchedLines, config.start, config.end),
    totalLines: allLines.length,
    matchCount: matchedLines.length,
    hiddenLines,
    hasQuery,
  };
}

function buildTracePhaseGroups<PreparedLine extends TracePreparedLine<Phase>, Phase extends string>(
  lines: PreparedLine[],
  start: (line: PreparedLine) => number,
  end: (line: PreparedLine) => number,
): TracePhaseRange<Phase>[] {
  const groups: TracePhaseRange<Phase>[] = [];
  for (const line of lines) {
    const last = groups[groups.length - 1];
    if (last && last.phase === line.phase) {
      last.count += 1;
      last.end = end(line);
      continue;
    }
    groups.push({
      phase: line.phase,
      phaseLabel: line.phaseLabel,
      count: 1,
      start: start(line),
      end: end(line),
    });
  }
  return groups;
}
