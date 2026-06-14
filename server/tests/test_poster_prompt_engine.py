# -*- coding: utf-8 -*-
"""海报提示词扩写引擎的纯逻辑单测（不连真实 DeepSeek、不依赖 DB）。

打桩策略：mock 掉模块内 `_get_client()` 返回的 client，
其 `chat.completions.create` 用 AsyncMock 返回伪造的 OpenAI 响应对象。
覆盖：正常扩写 / 解析失败降级 / 调用异常降级 / needs 透传与过滤空项。
"""
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import services.poster_prompt_engine as ppe


def _fake_response(content: str) -> SimpleNamespace:
    """伪造 chat.completions.create 的返回：resp.choices[0].message.content。"""
    return SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content=content))]
    )


def _patch_client(create_mock: AsyncMock):
    """把 _get_client 替换成返回带桩 create 的伪 client。"""
    fake_client = MagicMock()
    fake_client.chat.completions.create = create_mock
    return patch.object(ppe, "_get_client", return_value=fake_client)


async def test_normal_returns_parsed_dict():
    # 正常：mock 返回合法 JSON（含 image_prompt + needs）→ 返回对应 dict
    create = AsyncMock(
        return_value=_fake_response(
            '{"image_prompt": "A billiards hall poster, cinematic lighting", '
            '"needs": ["报名方式"]}'
        )
    )
    with _patch_client(create):
        result = await ppe.expand_poster_prompt(
            "搞个周末比赛海报",
            poster_text={"title": "周末争霸赛", "lines": ["报名从速"]},
        )

    assert result == {
        "image_prompt": "A billiards hall poster, cinematic lighting",
        "needs": ["报名方式"],
    }
    create.assert_awaited_once()


async def test_invalid_json_falls_back():
    # 解析失败：mock 返回非 JSON 文本 → 降级返回 {image_prompt: description, needs: []}
    create = AsyncMock(return_value=_fake_response("这不是 JSON，纯文本胡说"))
    with _patch_client(create):
        result = await ppe.expand_poster_prompt("随便写点啥")

    assert result == {"image_prompt": "随便写点啥", "needs": []}


async def test_exception_falls_back_without_raising():
    # 异常：mock create 抛异常 → 同样降级、不抛出
    create = AsyncMock(side_effect=RuntimeError("network boom"))
    with _patch_client(create):
        result = await ppe.expand_poster_prompt("招聘海报")

    assert result == {"image_prompt": "招聘海报", "needs": []}


async def test_needs_passthrough_and_filters_empty():
    # needs 透传：带 needs 的 JSON → 原样返回，过滤空白项、非字符串转 str
    create = AsyncMock(
        return_value=_fake_response(
            '{"image_prompt": "poster prompt", '
            '"needs": ["联系方式", "", "  ", "待遇范围", 123]}'
        )
    )
    with _patch_client(create):
        result = await ppe.expand_poster_prompt("招人海报")

    assert result["image_prompt"] == "poster prompt"
    assert result["needs"] == ["联系方式", "待遇范围", "123"]


async def test_empty_image_prompt_falls_back():
    # 合法 JSON 但 image_prompt 为空 → 视为无效，降级
    create = AsyncMock(return_value=_fake_response('{"image_prompt": "", "needs": []}'))
    with _patch_client(create):
        result = await ppe.expand_poster_prompt("描述兜底")

    assert result == {"image_prompt": "描述兜底", "needs": []}
