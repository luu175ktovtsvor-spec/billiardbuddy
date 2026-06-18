# BYOK（门店自带大模型 Key）— 后端实现（2026-06-17）

> 让门店接入自己的大模型 API Key，**token 成本与并发由门店自担**。
> 解决"全员共用平台单 key"的两个硬伤：① 并发瓶颈（换 v4-pro 并发仅 500、MiMo 更低，全员挤一个 key 必 429）；② 成本不可持续（老板替所有门店付 token 钱）。
> 顺带和"模型质量"发现互补：平台默认用便宜的 v4-flash，想要更强对齐的门店自己接 v4-pro/MiMo 自付费。

## 架构（最小侵入，现有非 BYOK 行为 100% 不变）

| 层 | 实现 | 文件 |
|----|------|------|
| 加密 | Fernet 对称加密，主密钥存 env `BYOK_ENCRYPT_KEY`，DB 只存密文 | `core/crypto.py` |
| 数据 | stores 表加 `byok_enabled/byok_base_url/byok_api_key_enc/byok_model` | `models/store.py` + migration `021_store_byok` |
| Provider | `DeepSeekProvider.__init__` 加可选 `(api_key, base_url, default_model, timeout)`，默认 None→fallback settings（本质是通用 OpenAI 兼容 provider，可接 MiMo/v4-pro/任意兼容模型） | `services/ai/providers/deepseek.py` |
| 路由 | `ProviderFactory.get_text_provider_for_store(store)`：BYOK 门店→门店 provider（不入缓存，各店隔离）；否则平台单例；解密失败安全回退 | `services/ai/factory.py` |
| API | `GET/PUT/POST /stores/me/byok[/validate]`，owner-only，key 加密存、GET 不回显明文 | `api/v1/stores.py` |

## 生成路径覆盖（对抗 review 后全部接入）

| 路径 | 状态 |
|------|------|
| 非流式生成（run_generation：诊断/约客/玩法/批量/内容变体）| ✅ for_store |
| 工作台模板（workbench/copywriting/activity/operation）| ✅ for_store |
| 流式工作台（stream.py SSE）| ✅ for_store |
| **AI 对话管家**（agent/chat ReAct 循环）| ✅ for_store（review 修复） |
| **协作任务**（orchestrator 规划/岗位/汇总 3 处）| ✅ for_store（review 修复） |
| 店脑记忆学习（memory_service 后台旁路）| ⚪ 走平台 key（低频低量，**平台承担**，刻意决策） |
| 海报生图（gpt-image-2）| ⚪ 不在范围（独立 OpenAI key 体系，BYOK 文本不影响） |

## 安全（3 路对抗 review 验证通过）

- key **Fernet 加密存**，绝不明文落库；`GET /me/byok` 只返回是否配置 + 脱敏展示（`sk-abcd…wxyz`），不回显明文。
- **owner-only**：`_ensure_store_owner`（owner 或平台 admin）+ RBAC `STORE_UPDATE` 双校验。
- **安全回退**：主密钥未配置 / 坏密文 / key 欠费 → 容错回退平台默认，不阻断生成；validate 异常不回传原始消息（防调试信息泄露）。
- **租户隔离**：BYOK provider 不入单例缓存、`_client` 实例隔离，A 店 key 不可能泄漏给 B 店（review 确认零串店风险）。
- 配额：无需双轨——真实拦截是「次数」(generation_limit) 非 token；BYOK 门店用自己 key，token 成本自然转移，平台次数限制照常（商业模式不变）。

## 部署步骤

1. **生成主密钥**：`python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`，存服务器 env `BYOK_ENCRYPT_KEY`（不进代码库）。
2. **跑迁移**：`uv run alembic upgrade head`（021 给 stores 加 4 列）。
3. **前端配置页**（待做，见下）。

## 验证记录

- ✅ 端到端：构造 BYOK 门店用真实 MiMo key 生成成功（"周末办友谊赛送小奖品…"），加密往返 + 非 BYOK 回退 + 坏 key 安全回退全过。
- ✅ 回归：pytest 187 passed（改动生成命脉零破坏）。
- ✅ 对抗 review：3 路（密钥泄露/租户隔离+覆盖/健壮性+权限）发现的 HIGH/MED/LOW 全部修复。

## 待办（下一步）

1. **前端配置页**（门店设置加「AI 配置」tab，owner 可见）：填 base_url/api_key/model + 「测试连接」按钮（调 validate）+ 状态展示（已配/未配，脱敏）。**需先按设计系统出设计图再写**（CLAUDE.md 前端规范）。
2. （可选）店脑学习也走门店 key：`memory_service` 加可选 provider 参数。当前刻意由平台承担（低频低量）。
3. （商业）BYOK 门店是否给更宽松的功能次数（边际成本≈0）——产品决策。
