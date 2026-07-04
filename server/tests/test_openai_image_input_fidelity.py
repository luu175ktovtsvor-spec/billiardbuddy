# -*- coding: utf-8 -*-
"""U5(E3d)：改图循环增强 - input_fidelity 参数。

查证结论(2026-07-04，openai python SDK 2.36.0 + 官方文档 developers.openai.com/api/docs/guides/image-generation
交叉核实)：
- `client.images.edit()` 的方法签名里确实有 `input_fidelity: Optional[Literal["high","low"]]`——
  参数名/取值都真实存在，不是凭空编的。
- 但官方文档明确写明："For gpt-image-2, omit this parameter; the API doesn't allow changing it
  because the model processes every image input at high fidelity automatically." ——即传了会 400，
  gpt-image-2 恒以最高保真处理输入图，不接受这个参数。gpt-image-2 是本项目当前唯一注册/路由的
  GPT 模型（OPENAI_IMAGE_MODELS 只有它一个），所以必须只在【非 gpt-image-2】的 GPT 模型上才透传，
  否则会把当前唯一在用的 GPT 边路打挂。

本文件用假 AsyncOpenAI 客户端(不连网)钉住这条防呆逻辑。
"""
import base64
import io
import types

import pytest

from services.ai.providers.openai_image import OpenAIImageProvider

_FAKE_IMAGE_BYTES = b"\x89PNGfakeimagebytes"


def _fake_response() -> types.SimpleNamespace:
    b64 = base64.b64encode(b"result-image-bytes").decode()
    return types.SimpleNamespace(data=[types.SimpleNamespace(b64_json=b64, url=None)])


class _FakeImagesNamespace:
    def __init__(self, recorder: list):
        self._recorder = recorder

    async def edit(self, **kwargs):
        self._recorder.append(("edit", kwargs))
        return _fake_response()

    async def generate(self, **kwargs):
        self._recorder.append(("generate", kwargs))
        return _fake_response()


class _FakeClient:
    def __init__(self, recorder: list):
        self.images = _FakeImagesNamespace(recorder)


async def test_input_fidelity_passed_for_non_gpt_image2_edit_model():
    """gpt-image-1(及未来其它非 gpt-image-2 的 GPT 兼容模型)：传了 input_fidelity 就该透传。"""
    provider = OpenAIImageProvider(api_key="k", base_url="https://api.openai.com/v1")
    recorder: list = []
    provider._client = _FakeClient(recorder)

    await provider.generate_image(
        prompt="把内容改一下", model="gpt-image-1", size="1024x1024",
        image=_FAKE_IMAGE_BYTES, input_fidelity="high",
    )

    kind, kwargs = recorder[-1]
    assert kind == "edit"
    assert kwargs.get("input_fidelity") == "high"


async def test_input_fidelity_omitted_for_gpt_image2_edit_model():
    """核心正确性要求：gpt-image-2 恒高保真、API 不接受该参数——即使调用方传了 input_fidelity，
    也绝不能透传给 gpt-image-2 的 edit 请求，否则会把当前唯一在用的 GPT 边路打挂(400)。"""
    provider = OpenAIImageProvider(api_key="k", base_url="https://api.openai.com/v1")
    recorder: list = []
    provider._client = _FakeClient(recorder)

    await provider.generate_image(
        prompt="把内容改一下", model="gpt-image-2", size="1024x1024",
        image=_FAKE_IMAGE_BYTES, input_fidelity="high",
    )

    kind, kwargs = recorder[-1]
    assert kind == "edit"
    assert "input_fidelity" not in kwargs, "gpt-image-2 不接受 input_fidelity，传了会 400"


async def test_input_fidelity_none_never_added_regardless_of_model():
    """调用方没传 input_fidelity(默认 None，绝大多数场景) → 不管什么模型都不该出现这个 key。"""
    provider = OpenAIImageProvider(api_key="k", base_url="https://api.openai.com/v1")
    recorder: list = []
    provider._client = _FakeClient(recorder)

    await provider.generate_image(
        prompt="随便画一张", model="gpt-image-2", size="1024x1024",
        image=_FAKE_IMAGE_BYTES,
    )

    kind, kwargs = recorder[-1]
    assert kind == "edit"
    assert "input_fidelity" not in kwargs


async def test_input_fidelity_not_forwarded_on_pure_generate_path():
    """images.generate()(无输入图，非编辑)本身没有 input_fidelity 这个字段——不该在这条路径出现。"""
    provider = OpenAIImageProvider(api_key="k", base_url="https://api.openai.com/v1")
    recorder: list = []
    provider._client = _FakeClient(recorder)

    await provider.generate_image(
        prompt="从零生成一张图", model="gpt-image-1", size="1024x1024",
        input_fidelity="high",  # 就算传了，非 edit 路径也不该用它
    )

    kind, kwargs = recorder[-1]
    assert kind == "generate"
    assert "input_fidelity" not in kwargs
