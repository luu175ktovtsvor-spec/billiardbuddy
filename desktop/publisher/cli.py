#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""桌面端"发布内核"入口(Electron 主进程 child_process 调它)。

用法(由 desktop/src/publish.js 拼命令):
  python cli.py login --platform <douyin|kuaishou|shipinhao|xiaohongshu>
  python cli.py check --platform <p>
  python cli.py post  --platform <p> --payload <payload.json 路径>

环境变量:
  SAU_SESSION_DIR      cookie/storage_state 存放目录(必给,主进程已注入)
  SAU_BROWSER_CHANNEL  可选,强制浏览器内核(chrome / chromium);默认自动探测真 Chrome
  SAU_HEADLESS         可选,=1 强制无头(仅 CI/自检用,真发布须有头)

输出:严格的 JSON-line 协议(见 base.py 顶部说明)。stdout 只走协议,日志走 stderr。

平台路由:douyin(抖音)/kuaishou(快手)/shipinhao(视频号·后台称 tencent)/
xiaohongshu(小红书),四家复用同一套协议与 patchright 持久上下文底座。
"""

import argparse
import asyncio
import json
import sys

from base import emit_result, emit_status, log

# 平台 → uploader 模块(后续加平台只在这登记)
PLATuploaders = {
    "douyin": "douyin_uploader",
    "kuaishou": "kuaishou_uploader",
    "shipinhao": "shipinhao_uploader",
    "xiaohongshu": "xiaohongshu_uploader",
}


def _load_uploader(platform: str):
    mod_name = PLATuploaders.get(platform)
    if not mod_name:
        return None
    try:
        return __import__(mod_name)
    except Exception as exc:
        log(f"[cli] import uploader '{mod_name}' failed: {exc}")
        return None


def _missing_dep_hint(exc: Exception) -> str:
    return (
        f"缺少运行依赖或浏览器未安装:{exc}。"
        "请在 publisher 目录执行:pip install -r requirements.txt && patchright install chromium"
    )


def cmd_login(platform: str) -> int:
    uploader = _load_uploader(platform)
    if uploader is None:
        emit_status("error", f"暂不支持平台:{platform}")
        return 2
    try:
        return asyncio.run(uploader.login())
    except ModuleNotFoundError as exc:
        emit_status("error", _missing_dep_hint(exc))
        return 3
    except Exception as exc:
        log(f"[cli] login fatal: {exc}")
        emit_status("error", f"登录失败:{exc}")
        return 1


def cmd_check(platform: str) -> int:
    uploader = _load_uploader(platform)
    if uploader is None:
        emit_result(ok=False, error=f"暂不支持平台:{platform}")
        return 2
    try:
        return asyncio.run(uploader.check())
    except ModuleNotFoundError as exc:
        emit_result(ok=False, error=_missing_dep_hint(exc))
        return 3
    except Exception as exc:
        log(f"[cli] check fatal: {exc}")
        emit_result(ok=False, error=str(exc))
        return 1


def cmd_post(platform: str, payload_path: str) -> int:
    uploader = _load_uploader(platform)
    if uploader is None:
        emit_result(ok=False, error=f"暂不支持平台:{platform}")
        return 2
    try:
        with open(payload_path, "r", encoding="utf-8") as f:
            payload = json.load(f)
    except Exception as exc:
        emit_result(ok=False, error=f"读取 payload 失败:{exc}")
        return 1
    try:
        return asyncio.run(uploader.post(payload))
    except ModuleNotFoundError as exc:
        emit_result(ok=False, error=_missing_dep_hint(exc))
        return 3
    except Exception as exc:
        log(f"[cli] post fatal: {exc}")
        emit_result(ok=False, error=str(exc))
        return 1


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="cli.py", description="桌面端抖音/多平台发布内核")
    sub = parser.add_subparsers(dest="action", required=True)

    p_login = sub.add_parser("login", help="扫码登录,存 cookie")
    p_login.add_argument("--platform", required=True)

    p_check = sub.add_parser("check", help="检查 cookie 是否有效")
    p_check.add_argument("--platform", required=True)

    p_post = sub.add_parser("post", help="发布(人确认后调用)")
    p_post.add_argument("--platform", required=True)
    p_post.add_argument("--payload", required=True, help="payload JSON 文件路径")

    args = parser.parse_args(argv)

    if args.action == "login":
        return cmd_login(args.platform)
    if args.action == "check":
        return cmd_check(args.platform)
    if args.action == "post":
        return cmd_post(args.platform, args.payload)
    return 2


if __name__ == "__main__":
    sys.exit(main())
