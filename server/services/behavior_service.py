"""行为信号层：从 generations 表算出门店最近的使用画像（BehaviorSnapshot），
供今日推荐做"实时跟进"——越用越懂你。全部基于已有数据，无需新埋点、跨设备。"""
import uuid
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from models.generation import Generation

# 最近行为的观察窗口
LOOKBACK_DAYS = 30
# 单次最多取多少条记录算信号（足够覆盖一个月的活跃门店，且有界）
MAX_ROWS = 300


@dataclass
class BehaviorSnapshot:
    """门店最近 30 天的使用画像。"""
    type_counts: Counter = field(default_factory=Counter)        # type -> 次数
    sub_type_counts: Counter = field(default_factory=Counter)    # sub_type -> 次数
    prompt_key_counts: Counter = field(default_factory=Counter)  # prompt_key -> 次数（"你常用"）
    recent_prompt_keys: list[str] = field(default_factory=list)  # 最近在前，用于"接着做"
    good_prompt_keys: set[str] = field(default_factory=set)      # 标过"效果好"的 prompt_key
    # 隐式反馈：老板点了今日推荐去做 → 那条生成记下 source_rec_id；这里按 rec.id 聚合采纳次数。
    # 采纳=弱正反馈（被点的推荐类别上浮）。空 = 还没人点过推荐。
    adopted_rec_ids: Counter = field(default_factory=Counter)    # rec.id -> 被采纳次数
    recent_total: int = 0                                        # 窗口内总条数

    def top_prompt_key(self, min_count: int = 2, prefer_good: bool = False) -> str | None:
        """最高频且达到阈值的 prompt_key（次数太低不算"常用"，避免误判）。
        prefer_good=True 时优先返回"既常做又标过效果好"的（L4 效果学习）。"""
        ranked = [(pk, cnt) for pk, cnt in self.prompt_key_counts.most_common() if cnt >= min_count]
        if prefer_good:
            for pk, _ in ranked:
                if pk in self.good_prompt_keys:
                    return pk
        return ranked[0][0] if ranked else None

    def adoption_rank(self, rec_id: str) -> int:
        """某条推荐最近被采纳了几次（隐式弱正反馈）。0 = 没被点过。排序加权用。"""
        return self.adopted_rec_ids.get(rec_id, 0)


async def get_behavior_snapshot(db: AsyncSession, store_id: uuid.UUID) -> BehaviorSnapshot:
    since = datetime.now(timezone.utc) - timedelta(days=LOOKBACK_DAYS)
    stmt = (
        select(
            Generation.type,
            Generation.sub_type,
            Generation.input_params,
            Generation.effect_rating,
            Generation.source_rec_id,
        )
        .where(
            Generation.store_id == store_id,
            Generation.is_deleted == False,
            Generation.created_at >= since,
        )
        .order_by(Generation.created_at.desc())
        .limit(MAX_ROWS)
    )
    rows = (await db.execute(stmt)).all()

    snap = BehaviorSnapshot(recent_total=len(rows))
    for r in rows:
        if r.type:
            snap.type_counts[r.type] += 1
        if r.sub_type:
            snap.sub_type_counts[r.sub_type] += 1
        pk = r.input_params.get("prompt_key") if isinstance(r.input_params, dict) else None
        if pk:
            snap.prompt_key_counts[pk] += 1
            snap.recent_prompt_keys.append(pk)
            if r.effect_rating == "good":
                snap.good_prompt_keys.add(pk)
        if r.source_rec_id:
            snap.adopted_rec_ids[r.source_rec_id] += 1
    return snap
