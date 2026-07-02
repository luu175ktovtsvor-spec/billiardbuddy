# BYOK（门店自带大模型 Key）— 后端实现（可选高级档）

> 📌 状态:✅现行 · 最后核对 2026-07-02

> ⚠️ **现状口径（2026-06-24 owner 拍板，见 `docs/待改清单-真机验收与打包-2026-06-23.md` 专题D，该文件已 gitignore 为本地档）**：产品已转向**全内置 owner 的 key、用户零配置不填 key**，"纯 BYOK·绝不内置平台 key"旧铁律作废。**BYOK 降为可选高级档**——老板可在高级设置里填自带 key 覆盖内置；未启用 BYOK 时回退到内置 key（而非吐 503）。下文加密 / 多供应商快切 / CC Switch 等实现仍有效，只是默认不走、作为可选档存在。

> 装在老板自己电脑上的桌面软件，默认 AI 文字/生图模型**全部走全内置 key（owner 提供）**；启用 BYOK 高级档时改由老板自带 key，**此时 token 成本与并发由门店自担**。
> key 取用次序：门店 BYOK（若启用）优先 → 否则内置 key；仅当内置 key 也未注入时才友好报错（不静默落到无关平台 key，这条守卫作不变量保留）。门店数据全在老板机器上的本地 SQLite，不连云。
> BYOK 自带模型可接任意 OpenAI 兼容端点（DeepSeek / 硅基流动 / 火山 / MiMo / v4-pro…），想要更强对齐就自己接更贵的模型、自付费。

## 架构（BYOK 可选高级档，本地 SQLite）

| 层 | 实现 | 文件 |
|----|------|------|
| 加密 | Fernet 对称加密，主密钥存 env `BYOK_ENCRYPT_KEY`，DB 只存密文 | `core/crypto.py` |
| 数据 | stores 表带 `byok_enabled/byok_base_url/byok_api_key_enc/byok_model`（+ 生图 `byok_image_*`）。**本地 SQLite**：`db/init_local.py` 建库 + 老库平滑补列，无需 alembic 迁移 | `models/store.py` + `db/init_local.py` |
| Provider | `DeepSeekProvider.__init__` 加可选 `(api_key, base_url, default_model, timeout)`，本质是通用 OpenAI 兼容 provider，可接 MiMo/v4-pro/任意兼容模型 | `services/ai/providers/deepseek.py` |
| 路由 | `ProviderFactory.get_text_provider_for_store(store)`：门店 BYOK provider（若启用，不入缓存、各店隔离）优先。**桌面 key 守卫**：`DESKTOP_LOCAL=1` 下 BYOK 优先 → 否则内置 key；仅当内置 key 也未注入才友好 503（绝不静默落到无关平台 key） | `services/ai/factory.py` |
| API | `GET/PUT/POST /stores/me/byok[/validate]`，本地 owner 直接管理，key 加密存、GET 不回显明文 | `api/v1/stores.py` |

## 生成路径覆盖（对抗 review 后全部接入）

| 路径 | 状态 |
|------|------|
| 非流式生成（run_generation：诊断/约客/玩法/批量/内容变体）| ✅ for_store |
| 工作台模板（workbench/copywriting/activity/operation）| ✅ for_store |
| 流式工作台（stream.py SSE）| ✅ for_store |
| **AI 对话管家**（agent ReAct 循环）| ✅ for_store |
| **协作任务**（orchestrator 规划/岗位/汇总 3 处）| ✅ for_store |
| 店脑记忆学习（memory_service 后台旁路）| ✅ for_store（启用 BYOK 时同走门店 key；否则走内置 key） |
| 海报生图 | ✅ for_store（门店自带生图 key，`byok_image_*`，`factory.get_image_config_for_store` 按门店路由；硅基流动 Kolors / 通义万相 / 即梦 / 火山 Seedream 原生 provider(`c6bac0c`,按 base_url 路由,图生图 base64) 等国内模型） |

## 安全（3 路对抗 review 验证通过）

- key **Fernet 加密存**，绝不明文落库；`GET /me/byok` 只返回是否配置 + 脱敏展示（`sk-abcd…wxyz`），不回显明文。
- **本地单用户**：`_ensure_store_owner` 校验当前用户即门店 owner（单用户本机恒成立；RBAC 多角色已随 SaaS 删除）。
- **回退内置、绝不静默落到无关平台 key**（守卫不变量）：BYOK 主密钥未配置 / 坏密文 / 未填 key → 回退到内置 key；仅当内置 key 也未注入时才吐友好 503 提示检查安装或去填自带 key；validate 异常不回传原始消息（防调试信息泄露）。
- **实例隔离**：BYOK provider 不入单例缓存、`_client` 按门店实例化（单店本地无跨店泄漏问题，机制保留）。
- 配额：BYOK 门店用自己 key，token 成本/并发由门店自担；本地次数/用量看板（成本看板）只做记录与展示。

## 部署步骤（桌面本地）

1. **主密钥**：`BYOK_ENCRYPT_KEY` 由 Electron 壳（`desktop/src/backend.js`）拉起本地后端时注入（不进代码库）。
2. **建库**：本地后端启动跑 `db/init_local.py` 建 SQLite 库 + 老库平滑补列（含 BYOK 各列），无需 alembic。
3. **前端配置页**：✅ 已落地（见下）。

## 验证记录

- ✅ 端到端：构造 BYOK 门店用真实 key 生成成功，加密往返 + 内置/BYOK 均未配时友好 503（绝不静默落到无关平台 key）+ 坏 key 报错全过。
- ✅ 对抗 review：3 路（密钥泄露/实例隔离+覆盖/健壮性）发现的 HIGH/MED/LOW 全部修复。

## 已落地（前端配置）

- ✅ **前端配置页**：门店设置「AI 配置」，填 base_url/api_key/model + 「测试连接」（调 validate）+ 状态展示（已配/未配，脱敏）。
- ✅ **CC Switch 式多供应商快切**：存多套 key + active 指针，预设卡片一键切换，原子写 + 自动备份 + 永留一个可用配置（文字 + 生图都覆盖）。
- ✅ **店脑学习同走门店 key**：`memory_service` 用 `get_text_provider_for_store`；启用 BYOK 时走门店 key，否则走内置 key。

> go-forward 主线工作（剩余产品化优化 37 项）见 `docs/完整优化清单.md`。
