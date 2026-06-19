"""SH-9 · prompt-cache 稳定性纪律（守门测试）。

PC（prompt caching）按 tools→system→messages 的前缀层级命中缓存：改前缀块=那一刻起 cache miss。
本测试把"前缀稳定"钉死，防后续改召回链/工具系统的代码随手破前缀：
- to_openai_tools() 多次调用字节完全一致（工具数组序列化稳定）
- approval._canonical 键序稳定（sort_keys，两端一致才能验签）
- anti-spin 的 call sig 键序稳定（同参不同键序算同一次空转）
- "追加类操作不改 index<N 的消息"（解锁工具/续写都只追加末尾，不动前缀）

⚠️ 注意（来自 SH-9 牵连风险）：本测试是给已有正确逻辑加守门，不是改它——
别在让测试过的过程中反而改坏现有的 sort_keys 逻辑。
"""
import json

from services.agent.approval import _canonical
from services.agent.registry import Tool, ToolRegistry


def _build_registry():
    reg = ToolRegistry()
    # 故意按非字母序注册，验证导出顺序跟插入序（稳定）走、不被重排
    for name in ("zed_tool", "alpha_tool", "mid_tool"):
        reg.register(Tool(
            name=name, description=f"{name} 描述",
            parameters={"type": "object", "properties": {"q": {"type": "string"}}, "required": ["q"]},
            handler=lambda a, c: None,
        ))
    return reg


def test_to_openai_tools_byte_stable_across_calls():
    reg = _build_registry()
    a = json.dumps(reg.to_openai_tools(), ensure_ascii=False)
    b = json.dumps(reg.to_openai_tools(), ensure_ascii=False)
    c = json.dumps(reg.to_openai_tools(), ensure_ascii=False)
    assert a == b == c  # 多次调用字节一致 → tools 前缀块 hash 稳定


def test_to_openai_tools_preserves_insertion_order():
    reg = _build_registry()
    names = [t["function"]["name"] for t in reg.to_openai_tools()]
    assert names == ["zed_tool", "alpha_tool", "mid_tool"]  # 插入序，不被字母重排


def test_real_default_registry_serialization_stable():
    """真实内置工具集（default_registry）序列化也必须字节稳定。"""
    from services.agent import tools as _tools  # noqa: F401  触发工具注册
    from services.agent.registry import default_registry
    a = json.dumps(default_registry.to_openai_tools(), ensure_ascii=False)
    b = json.dumps(default_registry.to_openai_tools(), ensure_ascii=False)
    assert a == b
    assert len(default_registry.to_openai_tools()) > 0


def test_canonical_key_order_stable():
    """approval._canonical 不同键序的同一组 args 必须产出同一字节串（sort_keys 生效）。"""
    args1 = {"b": 2, "a": 1, "c": {"y": 1, "x": 2}}
    args2 = {"c": {"x": 2, "y": 1}, "a": 1, "b": 2}
    assert _canonical("t", args1) == _canonical("t", args2)
    # 且确实是排序后的紧凑形式（无空格、键有序）
    assert _canonical("t", {"b": 2, "a": 1}) == '{"args":{"a":1,"b":2},"tool":"t"}'


def test_antispin_sig_key_order_stable():
    """anti-spin 的调用签名键序稳定：同参不同键序 → 同一 sig（算同一次空转）。
    复刻 loop._execute_tool 里的 sig 计算（json.dumps(..., sort_keys=True)）。"""
    a1 = {"x": 1, "y": 2}
    a2 = {"y": 2, "x": 1}
    sig1 = f"probe|{json.dumps(a1, sort_keys=True, ensure_ascii=False)}"
    sig2 = f"probe|{json.dumps(a2, sort_keys=True, ensure_ascii=False)}"
    assert sig1 == sig2


def test_append_does_not_change_prefix():
    """'追加类操作不改 index<N 的前缀'——SH-4 续写/SH-5 解锁工具都只 append 末尾。
    这里用纯 messages 列表语义验证：append 后 messages[:N] 逐字节不变。"""
    messages = [
        {"role": "system", "content": "你是台球房助手"},
        {"role": "user", "content": "写个文案"},
        {"role": "assistant", "content": "前半段"},
    ]
    prefix_before = json.dumps(messages, ensure_ascii=False)
    # 续写：append 已输出 + 续写提示（绝不就地改前面任何一条）
    messages.append({"role": "user", "content": "接着写完"})
    prefix_after = json.dumps(messages[:3], ensure_ascii=False)
    assert prefix_before == prefix_after  # 前 3 条前缀字节不变
