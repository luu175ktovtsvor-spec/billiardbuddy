# BYOK（门店自带大模型 Key）— 后端实现（桌面版纯 BYOK）

> 装在老板自己电脑上的桌面软件，AI 文字/生图模型**全部由老板自带 key**，**token 成本与并发由门店自担**。
> 桌面版是**纯 BYOK 铁律**：盒子不内置任何平台大模型 key——没配 key 即空 key、**绝不回退平台 key**、空 key → 友好 503。门店数据全在老板机器上的本地 SQLite，不连云。
> 自带模型可接任意 OpenAI 兼容端点（DeepSeek / 硅基流动 / 火山 / MiMo / v4-pro…），想要更强对齐就自己接更贵的模型、自付费。

## 架构（纯 BYOK，本地 SQLite）

| 层 | 实现 | 文件 |
|----|------|------|
| 加密 | Fernet 对称加密，主密钥存 env `BYOK_ENCRYPT_KEY`，DB 只存密文 | `core/crypto.py` |
| 数据 | stores 表带 `byok_enabled/byok_base_url/byok_api_key_enc/byok_model`（+ 生图 `byok_image_*`）。**本地 SQLite**：`db/init_local.py` 建库 + 老库平滑补列，无需 alembic 迁移 | `models/store.py` + `db/init_local.py` |
| Provider | `DeepSeekProvider.__init__` 加可选 `(api_key, base_url, default_model, timeout)`，本质是通用 OpenAI 兼容 provider，可接 MiMo/v4-pro/任意兼容模型 | `services/ai/providers/deepseek.py` |
| 路由 | `ProviderFactory.get_text_provider_for_store(store)`：用门店 BYOK provider（不入缓存，各店隔离）。**桌面纯 BYOK 守卫**：`DESKTOP_LOCAL=1` 没配即空 key、**绝不回退平台**；空 key → 友好 503 | `services/ai/factory.py` |
| API | `GET/PUT/POST /stores/me/byok[/validate]`，本地 owner 直接管理，key 加密存、GET 不回显明文 | `api/v1/stores.py` |

## 生成路径覆盖（对抗 review 后全部接入）

| 路径 | 状态 |
|------|------|
| 非流式生成（run_generation：诊断/约客/玩法/批量/内容变体）| ✅ for_store |
| 工作台模板（workbench/copywriting/activity/operation）| ✅ for_store |
| 流式工作台（stream.py SSE）| ✅ for_store |
| **AI 对话管家**（agent ReAct 循环）| ✅ for_store |
| **协作任务**（orchestrator 规划/岗位/汇总 3 处）| ✅ for_store |
| 店脑记忆学习（memory_service 后台旁路）| ✅ for_store（同走门店 key；门店无 key 时本地降级，不回退平台） |
| 海报生图 | ✅ for_store（门店自带生图 key，`byok_image_*`，`factory.get_image_config_for_store` 按门店路由；硅基流动 Kolors / 通义万相 / 即梦 等国内模型） |

## 安全（3 路对抗 review 验证通过）

- key **Fernet 加密存**，绝不明文落库；`GET /me/byok` 只返回是否配置 + 脱敏展示（`sk-abcd…wxyz`），不回显明文。
- **本地单用户**：`_ensure_store_owner` 校验当前用户即门店 owner（单用户本机恒成立；RBAC 多角色已随 SaaS 删除）。
- **纯 BYOK，绝不回退**（桌面铁律）：主密钥未配置 / 坏密文 / 未配 key → **不回退任何平台默认**，吐空 key、生成时返回友好 503 提示老板去配 key；validate 异常不回传原始消息（防调试信息泄露）。
- **实例隔离**：BYOK provider 不入单例缓存、`_client` 按门店实例化（单店本地无跨店泄漏问题，机制保留）。
- 配额：BYOK 门店用自己 key，token 成本/并发由门店自担；本地次数/用量看板（成本看板）只做记录与展示。

## 部署步骤（桌面本地）

1. **主密钥**：`BYOK_ENCRYPT_KEY` 由 Electron 壳（`desktop/src/backend.js`）拉起本地后端时注入（不进代码库）。
2. **建库**：本地后端启动跑 `db/init_local.py` 建 SQLite 库 + 老库平滑补列（含 BYOK 各列），无需 alembic。
3. **前端配置页**：✅ 已落地（见下）。

## 验证记录

- ✅ 端到端：构造 BYOK 门店用真实 key 生成成功，加密往返 + 空 key 友好 503（绝不回退平台）+ 坏 key 报错全过。
- ✅ 对抗 review：3 路（密钥泄露/实例隔离+覆盖/健壮性）发现的 HIGH/MED/LOW 全部修复。

## 已落地（前端配置）

- ✅ **前端配置页**：门店设置「AI 配置」，填 base_url/api_key/model + 「测试连接」（调 validate）+ 状态展示（已配/未配，脱敏）。
- ✅ **CC Switch 式多供应商快切**：存多套 key + active 指针，预设卡片一键切换，原子写 + 自动备份 + 永留一个可用配置（文字 + 生图都覆盖）。
- ✅ **店脑学习同走门店 key**：`memory_service` 用 `get_text_provider_for_store`；门店无 key 时本地降级，不回退平台。

> go-forward 主线工作（剩余产品化优化 37 项）见 `docs/完整优化清单.md`。
