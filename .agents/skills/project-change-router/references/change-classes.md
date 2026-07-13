# 改动分类

| 类别 | 判据 | 默认主 Skill |
|---|---|---|
| `FE_ONLY` | 只改变展示、交互或可丢失的本地偏好 | `change-frontend-module` |
| `BE_INTERNAL` | 外部契约不变的算法、存储、性能或 adapter 修改 | `change-backend-module` |
| `CONTRACT` | 路径、method、字段、事件、状态码、错误或 IPC payload 变化 | `change-shared-contract` |
| `FULLSTACK` | 一个用户能力需要前后端共同交付 | `deliver-fullstack-feature` |
| `MIGRATION` | 旧字段、旧存储或旧协议要分阶段迁移 | `change-shared-contract` |
| `CROSS_SERVICE` | 跨桌面、gateway、relay、dataeye 的远程协议 | `change-cross-service-api` |
| `REFACTOR` | 只改变结构、依赖或文件归属，行为必须不变 | `refactor-module-boundaries` |
| `DIAGNOSIS` | 只定位问题或影响面，不授权修复 | `analyze-change-impact` |
| `SECURITY` | 跨越文件、命令、权限、密钥、IPC、网络或扩展信任边界 | `audit-security-boundaries` |
| `RELEASE` | 版本、安装包、签名、更新、发布或回滚 | `release-desktop-safely` |
| `GOVERNANCE` | AI 开发规则、工程 Skill、质量门、CI 或模块地图变化 | `maintain-project-skills` |

## 组合规则

- 先选一个描述交付目标的主类别，再附加风险类别。
- `FULLSTACK + CONTRACT`：新 UI 需要新接口或事件。
- `CONTRACT + CROSS_SERVICE + MIGRATION`：远程字段改名。
- `REFACTOR` 不与行为变更同批；发现行为需求时拆任务。
- 仅修改一端但改变了边界，仍属于 `CONTRACT`，不能标成 `FE_ONLY` 或 `BE_INTERNAL`。
