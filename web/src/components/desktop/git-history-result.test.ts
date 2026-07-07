import { describe, expect, test } from "vitest";

import { parseGitHistoryResult } from "./git-history-result";

describe("parseGitHistoryResult", () => {
  test("parses commits and bounded patch", () => {
    const parsed = parseGitHistoryResult(`<git_history is_git="true" status="completed" rev="HEAD" count="2" patch="true">
<commits>
<commit sha="abc123" short_sha="abc123" author="Test User" date="2026-07-07T18:00:00+08:00">
<title>
update &amp; polish
</title>
</commit>
<commit sha="def456" short_sha="def456" author="Test User" date="2026-07-06T18:00:00+08:00">
<title>
init
</title>
</commit>
</commits>
<patch bytes="80" limit="80" truncated="true" exit_code="0">
diff --git a/a.ts b/a.ts
+new
</patch>
</git_history>`);

    expect(parsed).toMatchObject({
      isGit: true,
      status: "completed",
      rev: "HEAD",
      count: 2,
      patchRequested: true,
      commits: [
        { sha: "abc123", shortSha: "abc123", title: "update & polish" },
        { sha: "def456", shortSha: "def456", title: "init" },
      ],
      patch: {
        bytes: 80,
        limit: 80,
        truncated: true,
        exitCode: 0,
      },
    });
    expect(parsed?.patch?.text).toContain("+new");
  });

  test("parses invalid rev and non-git results", () => {
    expect(parseGitHistoryResult(`<git_history is_git="true" status="invalid_rev" rev="--all">
rev 无效
</git_history>`)).toMatchObject({
      isGit: true,
      status: "invalid_rev",
      message: "rev 无效",
    });

    expect(parseGitHistoryResult(`<git_history is_git="false">
当前工作区不是 git 仓库。
</git_history>`)).toMatchObject({
      isGit: false,
      message: "当前工作区不是 git 仓库。",
    });
  });

  test("parses stored git history preview", () => {
    const parsed = parseGitHistoryResult(`<stored_tool_result tool="git_history" call_id="c1" chars="60000" bytes="61000" path="/tmp/git-history.txt">
<preview_head chars="240">
&lt;git_history is_git=&quot;true&quot; status=&quot;completed&quot; rev=&quot;HEAD&quot; count=&quot;1&quot; patch=&quot;true&quot;&gt;
&lt;commits&gt;
&lt;commit sha=&quot;abc123&quot; short_sha=&quot;abc123&quot; author=&quot;Test User&quot; date=&quot;2026-07-07T18:00:00+08:00&quot;&gt;
&lt;title&gt;
stored commit
&lt;/title&gt;
&lt;/commit&gt;
</preview_head>
<preview_tail chars="80">
&lt;/commits&gt;
&lt;/git_history&gt;
</preview_tail>
</stored_tool_result>`);

    expect(parsed).toMatchObject({
      isGit: true,
      status: "completed",
      rev: "HEAD",
      count: 1,
      patchRequested: true,
      commits: [{ sha: "abc123", shortSha: "abc123", title: "stored commit" }],
      stored: {
        path: "/tmp/git-history.txt",
        chars: 60000,
        bytes: 61000,
      },
    });
  });

  test("ignores ordinary output", () => {
    expect(parseGitHistoryResult("plain text")).toBeNull();
  });
});
