import { describe, expect, test } from "vitest";

import { parseGitStatusResult } from "./git-status-result";

describe("parseGitStatusResult", () => {
  test("parses git status and bounded diff", () => {
    const parsed = parseGitStatusResult(`<git_status is_git="true" branch="main" diff="true" staged="both" scope="both">
<summary files="2" staged="1" worktree="1" untracked="1" modified="1" added="0" deleted="0" renamed="0" copied="0" conflicted="0" clean="false" />
<status>
## main
 M src/app.ts
?? src/new.ts
</status>
<diff_stat>
src/app.ts | 2 +-
</diff_stat>
<diff bytes="80" limit="80" truncated="true">
diff --git a/src/app.ts b/src/app.ts
-old
+new
</diff>
<staged_diff_stat>
src/staged.ts | 2 +-
</staged_diff_stat>
<staged_diff bytes="60" limit="80" truncated="false">
diff --git a/src/staged.ts b/src/staged.ts
-old staged
+new staged
</staged_diff>
<untracked_files count="1" bytes="24" limit="40000" truncated="false">
<file path="src/new.ts" size="24" bytes="24" truncated="false" binary="false">
export const fresh = true
</file>
</untracked_files>
</git_status>`);

    expect(parsed).toMatchObject({
      isGit: true,
      branch: "main",
      staged: false,
      scope: "both",
      summary: {
        files: 2,
        staged: 1,
        worktree: 1,
        untracked: 1,
        modified: 1,
        added: 0,
        deleted: 0,
        renamed: 0,
        copied: 0,
        conflicted: 0,
        clean: false,
      },
      status: "## main\n M src/app.ts\n?? src/new.ts",
      diffStat: "src/app.ts | 2 +-",
      stagedDiffStat: "src/staged.ts | 2 +-",
      diff: {
        bytes: 80,
        limit: 80,
        truncated: true,
      },
      stagedDiff: {
        bytes: 60,
        limit: 80,
        truncated: false,
      },
      untrackedFiles: [
        {
          path: "src/new.ts",
          size: 24,
          bytes: 24,
          truncated: false,
          binary: false,
          content: "export const fresh = true",
        },
      ],
      untrackedTruncated: false,
    });
    expect(parsed?.diff?.text).toContain("+new");
    expect(parsed?.stagedDiff?.text).toContain("+new staged");
  });

  test("parses non-git result", () => {
    const parsed = parseGitStatusResult(`<git_status is_git="false">
当前工作区不是 git 仓库。
</git_status>`);
    expect(parsed).toMatchObject({ isGit: false, status: "当前工作区不是 git 仓库。" });
  });

  test("parses stored git status preview", () => {
    const parsed = parseGitStatusResult(`<stored_tool_result tool="git_status" call_id="c1" chars="50000" bytes="52000" path="/tmp/git-status.txt">
<preview_head chars="200">
&lt;git_status is_git=&quot;true&quot; branch=&quot;main&quot; diff=&quot;true&quot; staged=&quot;both&quot; scope=&quot;both&quot;&gt;
&lt;status&gt;
## main
 M src/app.ts
&lt;/status&gt;
&lt;diff_stat&gt;
src/app.ts | 2 +-
&lt;/diff_stat&gt;
</preview_head>
<preview_tail chars="80">
&lt;/git_status&gt;
</preview_tail>
</stored_tool_result>`);

    expect(parsed).toMatchObject({
      isGit: true,
      branch: "main",
      scope: "both",
      status: "## main\n M src/app.ts",
      diffStat: "src/app.ts | 2 +-",
      stored: {
        path: "/tmp/git-status.txt",
        chars: 50000,
        bytes: 52000,
      },
    });
  });

  test("ignores ordinary output", () => {
    expect(parseGitStatusResult("plain text")).toBeNull();
  });
});
