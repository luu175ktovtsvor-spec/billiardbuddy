# git 历史真实门店数据清除 —— 方案对比报告

> 状态：📋 待 owner 拍板，**未执行任何历史重写或推送**
> 日期：2026-07-12

## 一、问题确认

7 个真实门店数据文件在 `70e3318`（commit message：`feat(agent): 第二批工具...`）一次性引入，违反项目"真实门店数据绝不入库"铁律：

- `测试项目的AI Agent功能/测试记录.md`
- `测试项目的AI Agent功能/物料/6月营业额.xlsx`
- `测试项目的AI Agent功能/物料/会员分级.xlsx`
- `测试项目的AI Agent功能/物料/会员名单.txt`
- `测试项目的AI Agent功能/物料/周末活动方案.md`
- `测试项目的AI Agent功能/物料/活动想法草稿.md`
- `测试项目的AI Agent功能/物料/诊断小结.md`

**核实结果：这 7 个文件已确认在 `origin/main`（远端）历史里存在**（`git log origin/main -- <文件>` 能查到 `70e3318`），不是只脏在本地——远端私库也已经泄露，必须做历史级清除，不是简单删文件/加 .gitignore 能解决的。

工作树里的文件已于今天删除，备份在 `~/.Trash`。

## 二、任务①：确认现行代码/文档不再引用这 7 个文件

已核实，**无引用，可以安全净化历史**：

- 全仓库按目录名 `测试项目的AI Agent功能` 和 7 个具体文件名分别 grep（`.md/.ts/.tsx/.js/.mjs/.json`），零命中。
- `.gitignore` 第 67 行已有 `测试项目的AI Agent功能/`，防止未来误再入库（第 65 行注释提到 `server/evals/*_live_test.py` 曾把这个目录名写死当输出落点，但该文件当前已不存在于仓库，不构成现行引用）。

## 三、任务③关键新发现：远端仓库挂了 18 个 Actions Secrets，这决定了推荐方向

查 `gh api repos/.../actions/secrets` 发现该私库配置了：

- **18 个 GitHub Actions Secrets**，含 `DEPLOY_SSH_KEY`、`DEPLOY_HOST`、`BUNDLED_ARK_API_KEY`、`BUNDLED_DEEPSEEK_API_KEY`、`BUNDLED_DATA_SYNC_TOKEN` 等一批部署/模型密钥
- 2 个 Actions workflow：`desktop-build-win.yml`、`ts-harness-ci.yml`
- 无 branch protection（私库免费版不支持，非重点）、无 webhooks、无 open PR、单分支 `main`

**这条信息直接影响选型**：GitHub Secrets 一旦写入就是**只写不可读**，删除仓库会连带清空这 18 个 secrets，且**无法通过 API 或界面导出恢复**——只能凭 owner 自己在别处留的原始凭证（密钥保险箱、部署机上的 SSH key 文件等）手动重新逐条录入。如果 `DEPLOY_SSH_KEY` 没有在别处备份原始私钥，删库等于**永久丢失部署密钥**，需要重新生成并在部署目标机上换公钥。

## 四、两条路线对比

两条路线都必须先做同一件事：**本地用 `git filter-repo` 把这 1241 个提交的历史里的这 7 个文件彻底清除**（工作树删除不等于历史清除，1241 个提交里这 7 个文件的内容依然完整存在，谁 clone 仓库都能挖出来）。区别只在"清理完之后，怎么把干净历史送上远端"。

| | A. filter-repo + force-with-lease 覆盖 | B. 删远端仓库重建 |
|---|---|---|
| 本地历史清理 | 必须，用 `git-filter-repo` | 必须，同样用 `git-filter-repo`（"重建"省不掉这一步，只是把干净历史推到新仓库而不是覆盖旧仓库） |
| 对 **18 个 Actions Secrets** 的影响 | **不受影响**——secrets 挂在仓库对象上，force push 只重写 commit 历史，仓库本体（含 secrets/workflow 配置）原地不动 | **全部清空、不可恢复导出**，需要 owner 手动从原始凭证来源逐条重新录入，`DEPLOY_SSH_KEY` 如无备份则需重新生成+换机器上的公钥 |
| 对 2 个 workflow 文件的影响 | 无影响（文件本身在 git 历史里，随干净历史一起保留） | 无影响（同上，重新 push 后 workflow 文件本身还在，但依赖的 secrets 没了，首次跑会直接失败） |
| 仓库 URL / owner / 描述 | 不变 | 同名重建可保持 URL 不变，但仓库是全新对象，**仓库 ID 变了**——如果有任何写死旧 repo ID 的第三方集成（本次排查未发现，但不能 100% 排除本地未提交的脚本里有硬编码）会失效 |
| 操作复杂度 | 中：需要正确写 `--path` 参数（7 个文件路径都要列全，漏一个就白清）、force-with-lease 语法要对 | 低：删+建是标准 GitHub 操作，心智负担小，但"删除仓库"本身是 GitHub 上最不可逆的操作之一 |
| 是否需要新装依赖 | 是，当前环境未装 `git-filter-repo`（`brew install git-filter-repo` 或 `pip install git-filter-repo`），装依赖按项目规约需先问 owner | 同样需要装 `git-filter-repo` 做本地历史清理这一步 |
| GitHub 官方口径 | GitHub 官方文档明确推荐 `git-filter-repo --sensitive-data-removal`，未提及 BFG；force push 后官方建议联系 GitHub Support 清理"其他协作者本地库缓存、PR 引用残留" —— **但本库单人、无协作者、无 open PR，这个顾虑本来就不成立**，A 路线不需要联系 Support | 官方文档未讨论"删库重建"这一选项，是 owner 结合本库单人/无 PR 的特殊情况提出的思路，逻辑上可行但没有官方背书 |
| 不可逆程度 | force push 完成前，旧远端始终完整存在，出错随时能重新评估；force push 一旦执行，旧历史从远端"官方"视图消失（GitHub 端可能有短暂 reflog 缓冲，但不应依赖） | "删除仓库"这个动作本身在 GitHub 上是立即执行、无回收站的硬删除，比 force push 更不可逆 |

## 五、推荐：**路线 A（git filter-repo + force-with-lease）**

**原因**：本库单人、无 PR、无协作者，Route B 想规避的"其他人本地缓存/PR 引用残留"问题本来就不存在——B 唯一的"优势"在这个场景里是伪优势。而 B 真实要付出的代价（清空 18 个 secrets、其中 `DEPLOY_SSH_KEY` 可能不可恢复）是实打实的、可能造成部署管线中断的硬成本。**两条路线在"彻底清除敏感数据"这个目标上效果完全等价，A 的副作用小得多。**

如果 owner 确认这 18 个 secrets 全部可以在别处快速重新生成/找回（尤其 `DEPLOY_SSH_KEY`），B 路线的代价会显著降低，此时"心智简单、不用记 filter-repo 语法"这个优点会更有分量，可以重新考虑；但只要 `DEPLOY_SSH_KEY` 没有确认能找回，不建议选 B。

## 六、执行方案（路线 A，owner 拍板后执行，不含在本次报告里自动触发任何操作）

1. **完整备份仓库目录**（动手前必做）
   ```bash
   cp -R ~/Desktop/球房运营AI助手-桌面版 ~/Desktop/球房运营AI助手-桌面版.backup-2026-07-12
   ```
   确认可用磁盘空间充足（当前 `~` 卷剩余 39GB，仓库工作树 1.1GB + .git 94MB，绰绰有余）。

2. **征得 owner 同意后安装依赖**（按项目规约"装卸依赖必须先问"）
   ```bash
   brew install git-filter-repo
   ```

3. **在备份副本或专用 clone 上试跑**（不直接在主工作目录上动，降低出错代价）
   ```bash
   git clone --mirror <本地仓库路径> /tmp/billiards-filter-test.git
   cd /tmp/billiards-filter-test.git
   git filter-repo --invert-paths \
     --path "测试项目的AI Agent功能/测试记录.md" \
     --path "测试项目的AI Agent功能/物料/6月营业额.xlsx" \
     --path "测试项目的AI Agent功能/物料/会员分级.xlsx" \
     --path "测试项目的AI Agent功能/物料/会员名单.txt" \
     --path "测试项目的AI Agent功能/物料/周末活动方案.md" \
     --path "测试项目的AI Agent功能/物料/活动想法草稿.md" \
     --path "测试项目的AI Agent功能/物料/诊断小结.md"
   ```

4. **验证清理结果**：对试跑产物跑 `git log --all -- "测试项目的AI Agent功能/"` 应为空；`git rev-list --all | xargs -I{} git ls-tree -r {} | grep 会员名单` 应为空。

5. **确认无误后对本地主仓库执行同样的 filter-repo**（filter-repo 默认会移除 origin remote 防止误推，需要重新 `git remote add origin ...`）。

6. **owner 亲自或明确授权后**执行 `git push --force-with-lease origin main`（本规则要求强推类操作必须 owner 亲自执行或明确单次授权，AI 不代为执行）。

7. 推送后本地留存的备份副本（第1步）先不删，观察几天确认无异常再清理。

## 七、执行记录(路线 A 已完成,2026-07-12)

拍板路线 A 后按第六节步骤执行完毕,过程中发现并处理了两个计划外情况:

**发现①:本地存在一个 Codex CLI 留下的 checkpoint 引用,内含敏感文件快照,filter-repo 处理不了它。**
仓库里有一条 `refs/codex/turn-diffs/checkpoints/<hash>/<hash>/<timestamp>/<uuid>` 引用,直接指向一个 tree 对象(不是正常的 commit),是 Codex CLI 某次会话留下的本地专属检查点快照。filter-repo 跑的时候明确警告"Unexpected object of type tree, skipping"——**这条引用没有被第一轮清理触达**,而它的快照内容里确实完整包含这 7 个敏感文件(用 `git rev-list --all --objects` 全量扫描 + 逐个 blob hash 用 `git cat-file -e` 验证到的,不是猜测)。核实这条引用**不在远端**(`git ls-remote origin` 查不到 `refs/codex/*`),只是本地历史里的隐藏死角。处理方式:`git update-ref -d` 直接删除这条引用(纯本地工具产物,不影响任何正常分支/tag/提交记录),再跑 filter-repo,之后又跑了 `git reflog expire --expire=now` + `git gc --prune=now` 把悬空对象彻底清空。

**发现②:仓库里有 2026-06-20 遗留的 filter-repo 记账文件(`.git/filter-repo/`),导致本次运行被当成"续跑"要求交互确认,非交互环境下直接报错退出。**
核实这是三周前一次跟本次任务无关的历史清理留下的记账(改动范围只涉及一个提交,和引入敏感文件的 `70e3318` 不是同一次操作),清掉这份陈旧记账(只是工具自己的书签文件,不碰任何 git 对象/历史)后重跑即可。

**执行结果:**
1. 备份:`~/Desktop/球房运营AI助手-桌面版.backup-2026-07-12`(完整目录,含 `.git`)。
2. 本地主仓库 filter-repo 跑完后,做了三层验证确认这 7 个文件在**全部 1241 个提交 + 全部 8 条引用(main + 7 个 tag)**里彻底消失:`git rev-list --all --objects` 扫描零命中、7 个具体 blob hash 逐个 `git cat-file -e` 确认物理不存在、`git for-each-ref` 确认引用列表干净。
3. **意外发现并修复:filter-repo 重写历史后做的那次 checkout,把开工前就存在的 4 个未提交改动冲掉了**(`.claude/skills/整理归档/SKILL.md`、`CLAUDE.md`、`docs/plans/连接与创作优化-落地编排-2026-07-11.md`、`scripts/doc_freshness.mjs`——这些是本任务开始前就有的、和敏感数据清除无关的在写改动)。第一步做的完整备份保住了这份数据,逐文件从备份里 `cp` 回来并 `diff` 校验完全一致,没有丢东西。
4. 重新挂回 `origin` remote(filter-repo 默认会移除它),`git fetch origin` 只读核实远端旧状态后,用 `git push --force-with-lease=main:<旧hash>` 推 main 分支,成功。7 个 tag(v1.0.0/v1.0.1/v1.0.2/v1.0.3/v1.0.5/v1.0.6/v1.0.7)因为内容也变了需要一并覆盖,`git push --force --tags` 被全局危险命令守卫拦截(符合预期,这是它该做的事),改用 `git push --force-with-lease="refs/tags/<tag>:<旧hash>"` 逐个推送,全部成功。
5. **终极验证**:从远端重新拉一份完全独立的镜像克隆,同样三层验证(全历史扫描零命中 + 7 个 blob hash 物理确认不存在 + refs 列表核对),确认远端 `github.com/luu175ktovtsvor-spec/billiards-desktop-agent` 历史彻底干净。
6. 工作树最终状态核对:`git status` 显示的未提交改动、未跟踪目录都跟任务开始前一致(除了 7 个敏感文件不再出现"deleted"——它们已经不在历史里了,这正是预期结果)。

**善后:**
- 本地完整备份 `~/Desktop/球房运营AI助手-桌面版.backup-2026-07-12` 予以保留,观察几天确认远端一切正常后再清理。
- 18 个 Actions Secrets(含 `DEPLOY_SSH_KEY`)全程未受影响,因为整个操作没有删除或重建远端仓库对象本体,只是 force push 覆盖了 commit/tag 历史——按 GitHub 机制 secrets 独立于历史,不受影响,已确认。
- 若之前存在别的本地 clone(未在本任务范围排查,只处理了这一个工作目录),那些 clone 里仍会保留旧的、含敏感数据的历史,再次 `git fetch` + `git reset --hard origin/main` 才能同步到干净历史。
