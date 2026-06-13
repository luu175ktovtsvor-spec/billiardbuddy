# -*- coding: utf-8 -*-
"""平台超管账号运维脚本（独立管理后台用）。

用途：创建/确保一个**不绑任何门店**的平台超管账号（is_admin=True）。
设计：
- 密码只从环境变量 ADMIN_PASSWORD 读取，**绝不接受明文命令行参数、绝不打印密码**。
- 幂等：账号已存在则提升为超管（可选重置密码），不重复建。
- 不创建任何门店/门店成员——这正是"独立后台不挂个人账号"的核心。

运行（本地或服务器，需在 server/ 目录）：
    ADMIN_PHONE=10000000000 ADMIN_PASSWORD='强密码' PYTHONPATH=. .venv/bin/python scripts/manage_admin.py create
    PYTHONPATH=. .venv/bin/python scripts/manage_admin.py list
"""
import argparse
import asyncio
import os
import sys

from sqlalchemy import func, select

from core.security import hash_password
from db.session import async_session
from models.store import StoreMember
from models.user import User

_MIN_PASSWORD_LEN = 10


async def ensure_platform_admin(
    db, phone: str, password: str, name: str | None = None, reset_password: bool = True
) -> tuple[User, bool]:
    """确保存在一个平台超管账号（is_admin=True），返回 (user, created)。

    - 账号不存在 → 新建，is_admin=True、is_active=True、**不建任何门店**。
    - 账号已存在 → 提升为超管；reset_password=True 时重置密码。
    幂等：可反复运行。
    """
    user = (await db.execute(select(User).where(User.phone == phone))).scalar_one_or_none()
    created = False
    if user is None:
        user = User(
            phone=phone,
            password_hash=hash_password(password),
            name=name or "平台超管",
            is_active=True,
            is_admin=True,
        )
        db.add(user)
        created = True
    else:
        user.is_admin = True
        user.is_active = True
        if name:
            user.name = name
        if reset_password:
            user.password_hash = hash_password(password)
    await db.commit()
    await db.refresh(user)
    return user, created


async def count_store_memberships(db, user_id) -> int:
    """该账号关联的门店数（独立超管应为 0）。"""
    return await db.scalar(
        select(func.count(StoreMember.id)).where(StoreMember.user_id == user_id)
    )


async def list_admins(db) -> list[tuple[User, int]]:
    admins = (
        await db.execute(select(User).where(User.is_admin == True).order_by(User.created_at))
    ).scalars().all()
    out = []
    for a in admins:
        out.append((a, await count_store_memberships(db, a.id)))
    return out


def _read_password() -> str:
    pwd = os.environ.get("ADMIN_PASSWORD", "")
    if len(pwd) < _MIN_PASSWORD_LEN:
        sys.exit(
            f"✗ 必须用环境变量 ADMIN_PASSWORD 提供长度≥{_MIN_PASSWORD_LEN} 的强密码"
            "（不接受命令行明文，避免进 shell 历史）。"
        )
    return pwd


async def _cmd_create(args) -> None:
    phone = args.phone or os.environ.get("ADMIN_PHONE", "")
    if not phone:
        sys.exit("✗ 需提供 --phone 或环境变量 ADMIN_PHONE")
    password = _read_password()
    async with async_session() as db:
        user, created = await ensure_platform_admin(db, phone, password, name=args.name)
        stores = await count_store_memberships(db, user.id)
    action = "新建" if created else "已提升为超管"
    print(f"✓ {action}：phone={user.phone} name={user.name} is_admin={user.is_admin}")
    if stores:
        print(f"⚠ 该账号关联了 {stores} 个门店——独立超管建议用全新手机号，保持 0 门店。")
    else:
        print("✓ 该账号不绑任何门店（符合独立后台要求）。")


async def _cmd_list(_args) -> None:
    async with async_session() as db:
        admins = await list_admins(db)
    if not admins:
        print("（暂无超管账号）")
        return
    print(f"共 {len(admins)} 个超管：")
    for a, stores in admins:
        print(f"  - {a.phone}  name={a.name}  门店数={stores}  active={a.is_active}")


def main() -> None:
    parser = argparse.ArgumentParser(description="平台超管账号运维")
    sub = parser.add_subparsers(dest="cmd", required=True)
    pc = sub.add_parser("create", help="创建/确保平台超管（不绑门店）")
    pc.add_argument("--phone", default=None, help="超管手机号（或用 ADMIN_PHONE 环境变量）")
    pc.add_argument("--name", default=None, help="显示名（可选）")
    sub.add_parser("list", help="列出所有超管账号")
    args = parser.parse_args()
    asyncio.run(_cmd_create(args) if args.cmd == "create" else _cmd_list(args))


if __name__ == "__main__":
    main()
