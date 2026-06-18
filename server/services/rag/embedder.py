"""文本嵌入（真 RAG 的"算向量"那一步）。

两种后端，按 RAG_EMBEDDER 环境变量选，默认零依赖：
- deterministic（默认）：把字 bigram 哈希进固定维向量。零依赖、开箱即用、确定性（可测）。
  给的是【词面/lexical】相似度——共享 n-gram 越多越相似。不是真语义，但立刻能用。
- fastembed（可选升级）：本地 ONNX 小模型，真【语义】相似。装了 fastembed 且设 RAG_EMBEDDER=fastembed
  才用；导入失败安全回退 deterministic，不崩。

索引与查询必须用同一后端（维度一致），故 get_embedder 全局单例；维度随向量一起存，
搜索时按维度过滤，换后端后的旧向量自动忽略（不会因维度不齐而错配）。
"""
import hashlib
import logging
import math
import os

logger = logging.getLogger(__name__)

_DET_DIM = 256


def _ngrams(text: str) -> list[str]:
    """字 bigram（对中文友好）+ 短串退化为整串。已去空白、转小写。"""
    s = "".join((text or "").lower().split())
    if not s:
        return []
    if len(s) == 1:
        return [s]
    return [s[i:i + 2] for i in range(len(s) - 1)]


def _l2norm(vec: list[float]) -> list[float]:
    n = math.sqrt(sum(x * x for x in vec))
    if n == 0:
        return vec
    return [x / n for x in vec]


def cosine(a: list[float], b: list[float]) -> float:
    """两个【已 L2 归一化】向量的余弦相似度（= 点积）。维度不等返回 0（防错配）。"""
    if len(a) != len(b):
        return 0.0
    return sum(x * y for x, y in zip(a, b))


class DeterministicEmbedder:
    """零依赖哈希嵌入：字 bigram → 带符号哈希进 256 维 → L2 归一化。词面相似度。"""
    name = "deterministic"
    dim = _DET_DIM

    def embed(self, text: str) -> list[float]:
        vec = [0.0] * _DET_DIM
        for tok in _ngrams(text):
            h = int(hashlib.md5(tok.encode("utf-8")).hexdigest(), 16)
            idx = h % _DET_DIM
            sign = 1.0 if (h >> 8) & 1 else -1.0
            vec[idx] += sign
        return _l2norm(vec)


class FastEmbedEmbedder:
    """本地 ONNX 小模型（语义相似）。懒加载；模型首次用时下载到缓存。"""
    name = "fastembed"

    def __init__(self, model_name: str | None = None):
        from fastembed import TextEmbedding  # 懒导入：没装也不影响 deterministic
        self._model_name = model_name or os.environ.get(
            "RAG_FASTEMBED_MODEL", "intfloat/multilingual-e5-small"
        )
        self._m = TextEmbedding(model_name=self._model_name)
        # 用一次探测维度
        probe = list(self._m.embed(["维度探测"]))[0]
        self.dim = len(probe)

    def embed(self, text: str) -> list[float]:
        vec = list(self._m.embed([text or ""]))[0]
        return _l2norm([float(x) for x in vec])


_embedder = None


def get_embedder():
    """全局单例嵌入器。RAG_EMBEDDER=fastembed 且可用时用语义版，否则零依赖词面版。"""
    global _embedder
    if _embedder is not None:
        return _embedder
    backend = (os.environ.get("RAG_EMBEDDER") or "deterministic").lower()
    if backend == "fastembed":
        try:
            _embedder = FastEmbedEmbedder()
            logger.info("RAG 嵌入器=fastembed(%s, dim=%d)", _embedder._model_name, _embedder.dim)
            return _embedder
        except Exception:
            logger.warning("fastembed 不可用，回退零依赖词面嵌入", exc_info=True)
    _embedder = DeterministicEmbedder()
    return _embedder
