"""知识库加密打包（桌面全本地版的护城河保护）。

问题：桌面版要"全本地"，但 prompt/知识库是产品命根子——若明文 YAML 塞进安装包，
同行解开包就抄走。所以桌面打包时把全部模板加密成一个 `prompts.enc` 二进制块，
运行时在内存解密用，用户看到的是乱码、抄不走。

- **web/dev（云端 PostgreSQL）**：不设 `PROMPTS_PACK_KEY` → 走明文 YAML（server/prompts/），行为不变。
- **桌面打包**：构建时设 `PROMPTS_PACK_KEY`(Fernet) → 生成 prompts.enc、只把它塞进安装包（不塞明文 YAML）；
  运行时后端带同一个 key（打进可执行）→ 解密加载。

⚠️ 这是"抬高门槛"不是"绝对不可破"——客户端加密的 key 终究在包里，铁了心的逆向能拿到。
   对一个台球垂直工具足够；将来要更狠可改成"激活时从云端拉加密包"，load_pack 接口不变。
"""
import json
import os
import sys
from pathlib import Path


def _default_pack_path() -> Path:
    """加密块的落点。
    - web/dev：server/ 根（与 prompts/ 同级），= 本文件 parent.parent.parent。
    - PyInstaller 冻结后：build_backend.js 用 `--add-data=prompts.enc:.` 把它放进 bundle 根
      （sys._MEIPASS）。冻结态下 __file__ 的相对解析不可靠，直接认 _MEIPASS 最稳。
    """
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        return Path(sys._MEIPASS) / "prompts.enc"
    return Path(__file__).resolve().parent.parent.parent / "prompts.enc"


# 加密块默认放 server/ 根（与 prompts/ 同级）。桌面打包把它塞进后端可执行旁（bundle 根）。
PACK_PATH = _default_pack_path()


def _key() -> str | None:
    return os.environ.get("PROMPTS_PACK_KEY")


def load_pack() -> dict | None:
    """运行时：有加密包 + key 就解密返回 {key: data 模板字典}；否则 None（调用方走明文 YAML）。"""
    key = _key()
    if not key or not PACK_PATH.exists():
        return None
    from cryptography.fernet import Fernet
    raw = Fernet(key.encode()).decrypt(PACK_PATH.read_bytes())
    return json.loads(raw.decode("utf-8"))


def build_pack(templates: dict, out: Path = PACK_PATH) -> Path:
    """打包用：把已加载的 {key: data} 模板字典加密落盘成 prompts.enc。需设 PROMPTS_PACK_KEY。"""
    key = _key()
    if not key:
        raise RuntimeError("打包知识库需设环境变量 PROMPTS_PACK_KEY(Fernet)；"
                           "生成：python -c \"from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())\"")
    from cryptography.fernet import Fernet
    blob = Fernet(key.encode()).encrypt(json.dumps(templates, ensure_ascii=False).encode("utf-8"))
    out.write_bytes(blob)
    return out
