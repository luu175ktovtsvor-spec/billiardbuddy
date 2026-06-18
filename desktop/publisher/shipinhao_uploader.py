# -*- coding: utf-8 -*-
"""视频号(微信)网页发布内核(patchright,channels.weixin.qq.com)。

平台后台称"视频号 = tencent",CLI 平台名用 shipinhao。

三个动作,均按 base.emit_* 协议输出:
  login : 打开视频号助手首页 → 从登录 iframe 抓二维码 dataUrl → 轮询发表按钮判成功 →
          storage_state 存 SAU_SESSION_DIR/shipinhao.json
  check : 用已存 storage_state 验 cookie 是否还有效 → emit result ok
  post  : 载入 storage_state → 发表页投喂视频 → 填标题/话题/描述 → 等上传完 →
          (原创声明)(封面)(定时)(短标题) → 点发表 → 等跳作品列表页 → emit result ok + url

流程与选择器搬自 dreammis/social-auto-upload 的 tencent_uploader/main.py(已在真实视频号助手验证、已迁 patchright),
反检测改用 base.persistent_context 持久上下文最佳实践(不注入 stealth.min.js)。
"""

from __future__ import annotations

import asyncio
from pathlib import Path

from base import (
    emit_progress,
    emit_qrcode,
    emit_result,
    emit_status,
    log,
    persistent_context,
    storage_state_path,
)
# 注意:模块名特意不叫 selectors.py —— 会和 Python 标准库 selectors 撞名。
from sph_selectors import COVER, FILL, LOGIN, PUBLISH, SCHEDULE, UPLOAD, URLS

PLATFORM = "shipinhao"


def _format_short_title(origin_title: str) -> str:
    """短标题规整:只保留字母数字 + 少量允许符号,长度 6~16。"""
    allowed = "《》“”:+?%°"
    filtered = [
        ch if ch.isalnum() or ch in allowed else " " if ch == "," else ""
        for ch in (origin_title or "")
    ]
    s = "".join(filtered)
    if len(s) > 16:
        s = s[:16]
    elif len(s) < 6:
        s += " " * (6 - len(s))
    return s


# ── 公共:cookie 校验 ─────────────────────────────────────────────────────
async def _cookie_valid(page) -> bool:
    """打开发表页;出现"扫码登录" = 失效;出现发表按钮/发表视频 = 有效。"""
    try:
        await page.goto(URLS["upload"], wait_until="domcontentloaded")
    except Exception as exc:
        log(f"[shipinhao] goto upload failed: {exc}")
        return False
    try:
        await page.wait_for_url(URLS["upload"], timeout=5000)
    except Exception:
        pass

    try:
        if await page.get_by_text(LOGIN["cookie_invalid_text"], exact=True).first.count():
            return False
    except Exception:
        pass

    for sel in ('div:has-text("发表视频")', 'button:has-text("发表")', 'input[type="file"]'):
        try:
            if await page.locator(sel).first.count():
                return True
        except Exception:
            continue
    return False


# ── login:扫码登录(二维码在 iframe) ──────────────────────────────────────
async def _extract_qrcode_src(page) -> str:
    """优先从登录 iframe 抓二维码;失败再退页面级选择器。"""
    if hasattr(page, "frame_locator"):
        try:
            iframe = page.frame_locator(LOGIN["iframe_src_match"])
            img = iframe.locator(LOGIN["iframe_qrcode_img"]).first
            await img.wait_for(state="visible", timeout=30000)
            src = await img.get_attribute("src")
            if src and src.startswith("data:image/"):
                return src
        except Exception:
            pass

    for sel in LOGIN["qrcode_fallbacks"]:
        img = page.locator(sel).first
        try:
            if not await img.count() or not await img.is_visible():
                continue
            src = await img.get_attribute("src")
            if src and src.startswith("data:image/"):
                return src
        except Exception:
            continue
    raise RuntimeError("未抓到视频号登录二维码 src")


async def _is_login_completed(page) -> bool:
    """登录成功 = 发表/草稿标志出现,且二维码区不再可见。"""
    for sel in LOGIN["login_done_markers"]:
        try:
            m = page.locator(sel).first
            if await m.count() and await m.is_visible():
                return True
        except Exception:
            continue

    if not (page.url.startswith(URLS["upload"]) or page.url.startswith(URLS["manage"])):
        return False

    for sel in LOGIN["login_box_markers"]:
        try:
            m = page.locator(sel).first
            if await m.count() and await m.is_visible():
                return False
        except Exception:
            continue
    return True


async def _is_qrcode_scanned(page) -> bool:
    for sel in LOGIN["scanned_tips"]:
        try:
            t = page.locator(sel).first
            if await t.count() and await t.is_visible():
                return True
        except Exception:
            continue
    return False


async def _is_qrcode_expired(page) -> bool:
    for sel in LOGIN["expired_tips"]:
        try:
            t = page.locator(sel).first
            if await t.count() and await t.is_visible():
                return True
        except Exception:
            continue
    return False


async def _refresh_qrcode(page):
    for sel in LOGIN["refresh_wraps"]:
        try:
            w = page.locator(sel).first
            if await w.count() and await w.is_visible():
                await w.click()
                return
        except Exception:
            continue
    # 退而点失效提示本身
    for sel in LOGIN["expired_tips"]:
        try:
            t = page.locator(sel).first
            if await t.count() and await t.is_visible():
                await t.click()
                return
        except Exception:
            continue


async def login() -> int:
    """打开视频号助手扫码登录。成功存 storage_state 并返回 0,失败返回 1。"""
    state_path = storage_state_path(PLATFORM)
    try:
        async with persistent_context(PLATFORM) as (context, page):
            emit_status("waiting", "正在打开视频号助手…")

            # 若已登录(持久 profile 还留着 session),直接落 state 收工
            if await _cookie_valid(page):
                await context.storage_state(path=str(state_path))
                emit_status("success", "已是登录态,无需扫码")
                return 0

            await page.goto(URLS["login"], wait_until="domcontentloaded")

            try:
                src = await _extract_qrcode_src(page)
            except Exception as exc:
                emit_status("error", f"抓二维码失败:{exc}")
                return 1

            emit_qrcode(src)
            emit_status("waiting", "二维码已就绪,请用微信扫码")

            # 轮询登录态(约 5 分钟:100 次 × 3s)
            poll_interval, max_checks = 3, 100
            scanned_announced = False
            for _ in range(max_checks):
                if await _is_login_completed(page):
                    await asyncio.sleep(2)
                    await context.storage_state(path=str(state_path))
                    if await _cookie_valid(page):
                        emit_status("success", "扫码登录成功")
                        return 0
                    emit_status("error", "扫码流程结束但 cookie 校验失败")
                    return 1

                if not scanned_announced and await _is_qrcode_scanned(page):
                    emit_status("scanned", "已扫码,等待手机确认…")
                    scanned_announced = True

                if await _is_qrcode_expired(page):
                    emit_status("expired", "二维码已失效,正在刷新…")
                    await _refresh_qrcode(page)
                    await asyncio.sleep(1)
                    try:
                        src = await _extract_qrcode_src(page)
                        emit_qrcode(src)
                        emit_status("waiting", "新二维码已就绪,请重新扫码")
                    except Exception:
                        pass

                await asyncio.sleep(poll_interval)

            emit_status("expired", "等待扫码超时")
            return 1
    except Exception as exc:
        log(f"[shipinhao] login crashed: {exc}")
        emit_status("error", f"登录进程异常:{exc}")
        return 1


# ── check:cookie 是否有效 ───────────────────────────────────────────────
async def check() -> int:
    state_path = storage_state_path(PLATFORM)
    if not state_path.exists():
        emit_result(ok=False)
        return 0
    try:
        async with persistent_context(PLATFORM) as (context, page):
            ok = await _cookie_valid(page)
            emit_result(ok=ok)
        return 0
    except Exception as exc:
        log(f"[shipinhao] check crashed: {exc}")
        emit_result(ok=False)
        return 0


# ── post:发布视频 ───────────────────────────────────────────────────────
async def _fill_title_tags_desc(page, title: str, tags: list, desc: str):
    """填标题 + 话题 + 描述(都打进同一个 contenteditable 编辑器)。"""
    editor = page.locator(FILL["editor"])
    await editor.click()
    await page.keyboard.type(title or "")
    await page.keyboard.press("Enter")
    for tag in tags or []:
        tag = str(tag).lstrip("#").strip()
        if not tag:
            continue
        await page.keyboard.type("#" + tag)
        await page.keyboard.press("Space")
    if desc:
        await page.keyboard.press("Enter")
        await page.keyboard.type(desc)


async def _wait_video_uploaded(page, video_path: str, timeout_s: int = 600):
    """等上传完成(发表按钮可点),失败自动删除重传一次。"""
    loops = max(1, timeout_s // 2)
    for i in range(loops):
        try:
            btn = page.get_by_role("button", name=UPLOAD["publish_btn_name"])
            cls = await btn.get_attribute("class")
            if cls and UPLOAD["publish_btn_disabled_cls"] not in cls:
                emit_progress("upload", 100, "视频已上传完成")
                return True

            pct = min(90, 30 + int(i / loops * 60))
            emit_progress("upload", pct, "视频上传中…")

            failed = await page.locator(UPLOAD["upload_failed_marker"]).count()
            del_tag = await page.locator(UPLOAD["delete_tag"]).count()
            if failed and del_tag:
                emit_progress("upload", 50, "检测到上传失败,正在重传…")
                try:
                    await page.locator(UPLOAD["delete_tag"]).click()
                    await page.get_by_role(
                        "button", name=UPLOAD["delete_confirm_btn_name"], exact=True
                    ).click()
                    await page.locator(UPLOAD["video_file_input"]).set_input_files(video_path)
                except Exception as exc:
                    log(f"[shipinhao] reupload failed: {exc}")
        except Exception:
            pass
        await asyncio.sleep(2)
    return False


async def _apply_original_statement(page):
    """声明原创(可选项):页面有入口就勾,无入口跳过、不中断发布。"""
    try:
        if await page.get_by_label("视频为原创").count():
            await page.get_by_label("视频为原创").check()
            log("[shipinhao] 视频为原创 checked")
            return
    except Exception:
        pass
    # 新版"声明原创"入口:有就点,无就跳过(声明原创为可选项)
    for text in ("声明原创", "原创声明", "视频为原创"):
        try:
            m = page.locator(f'text="{text}"').first
            if await m.count() and await m.is_visible():
                await m.click()
                await page.wait_for_timeout(800)
                log(f"[shipinhao] original statement clicked: {text}")
                return
        except Exception:
            continue
    log("[shipinhao] 无原创声明入口(可选项),跳过")


async def _set_short_title(page, title: str):
    """填短标题(部分账号必填;无入口则跳过)。"""
    try:
        anchor = (
            page.get_by_text(FILL["short_title_anchor"], exact=True)
            .locator("..")
            .locator("xpath=following-sibling::div")
            .locator(FILL["short_title_input"])
        )
        if await anchor.count():
            await anchor.fill(_format_short_title(title))
            log("[shipinhao] short title set")
    except Exception as exc:
        log(f"[shipinhao] short title skip: {exc}")


async def _set_cover(page, cover_path: str):
    """设竖版封面(3:4 个人主页卡片);弹窗找不到则跳过。"""
    if not cover_path or not Path(cover_path).exists():
        return
    try:
        emit_progress("fill", 80, "正在设置封面…")
        # 点封面入口
        opened = False
        for sel in COVER["portrait_selectors"] + COVER["landscape_selectors"]:
            entry = page.locator(sel).first
            try:
                if not await entry.count():
                    continue
                await entry.wait_for(state="visible", timeout=3000)
                await entry.click()
                await page.wait_for_timeout(500)
                opened = True
                break
            except Exception:
                continue
        if not opened:
            log("[shipinhao] no cover entry, skip")
            return

        # 找封面弹窗
        dialog = None
        for t in COVER["dialog_titles_portrait"] + COVER["dialog_titles_landscape"]:
            d = page.locator("div.weui-desktop-dialog").filter(has_text=t).first
            if await d.count():
                dialog = d
                break
        if dialog is None:
            log("[shipinhao] cover dialog not found, skip")
            return

        await dialog.wait_for(state="visible", timeout=5000)
        file_input = dialog.locator(COVER["cover_file_input"]).first
        await file_input.wait_for(state="attached", timeout=10000)
        await file_input.set_input_files(cover_path)
        await page.wait_for_timeout(1000)

        # 裁剪确认(若有)
        crop = page.locator("div.weui-desktop-dialog").filter(
            has_text=COVER["crop_dialog_title"]
        ).first
        if await crop.count():
            try:
                btn = crop.locator(COVER["crop_confirm_btn"]).first
                if await btn.count():
                    await btn.click()
                    await page.wait_for_timeout(800)
            except Exception:
                pass

        confirm = dialog.locator(COVER["confirm_btn"]).first
        await confirm.wait_for(state="visible", timeout=10000)
        await confirm.click()
        log("[shipinhao] cover set done")
    except Exception as exc:
        log(f"[shipinhao] set cover failed (skip): {exc}")


async def _set_schedule(page, schedule_dt):
    """设定时发布(weui DatePicker:选日期 → 翻月 → 选天 → 填小时)。"""
    try:
        label = page.locator("label").filter(has_text=SCHEDULE["label_text"]).nth(1)
        await label.click()
        await page.click(SCHEDULE["date_input"])

        current_month = schedule_dt.strftime("%m月")
        try:
            page_month = await page.inner_text(SCHEDULE["month_label"])
            if page_month != current_month:
                await page.click(SCHEDULE["next_month_btn"])
        except Exception:
            pass

        days = await page.query_selector_all(SCHEDULE["picker_days"])
        for el in days:
            cls = await el.evaluate("e => e.className")
            if SCHEDULE["picker_day_disabled_cls"] in cls:
                continue
            text = (await el.inner_text()).strip()
            if text == str(schedule_dt.day):
                await el.click()
                break

        await page.click(SCHEDULE["time_input"])
        await page.keyboard.press("Control+KeyA")
        await page.keyboard.type(schedule_dt.strftime("%H"))
        await page.locator(FILL["editor"]).click()
        log(f"[shipinhao] schedule set to {schedule_dt}")
    except Exception as exc:
        log(f"[shipinhao] set schedule failed (will publish immediately): {exc}")


async def post(payload: dict) -> int:
    """发布一条视频。payload = {videoPath,title,tags[],coverPath?,scheduleAt?}。"""
    video_path = payload.get("videoPath")
    title = payload.get("title") or ""
    tags = payload.get("tags") or []
    cover_path = payload.get("coverPath") or ""
    schedule_at = payload.get("scheduleAt") or ""
    desc = payload.get("desc") or ""

    # ── 入参校验 ──
    if not video_path or not Path(video_path).exists():
        emit_result(ok=False, error=f"视频文件不存在:{video_path}")
        return 1
    if not title.strip():
        emit_result(ok=False, error="标题不能为空")
        return 1

    schedule_dt = None
    if schedule_at:
        try:
            from datetime import datetime

            schedule_dt = datetime.fromisoformat(schedule_at.replace("Z", "+00:00"))
        except Exception:
            emit_result(ok=False, error=f"scheduleAt 不是合法 ISO 时间:{schedule_at}")
            return 1

    state_path = storage_state_path(PLATFORM)
    if not state_path.exists():
        emit_result(ok=False, error="未登录(无 cookie),请先扫码登录")
        return 1

    try:
        async with persistent_context(PLATFORM) as (context, page):
            # cookie 失效拦截
            if not await _cookie_valid(page):
                emit_result(ok=False, error="登录已失效,请重新扫码登录")
                return 1

            # ① 进发表页 ─────────────────────────────────
            emit_progress("upload", 5, "进入发表页…")
            await page.goto(URLS["upload"], wait_until="domcontentloaded")
            await page.wait_for_url(URLS["upload"], timeout=15000)

            # ② 投喂视频 ──────────────────────────────────
            emit_progress("upload", 15, "正在投喂视频文件…")
            try:
                await page.locator(UPLOAD["video_file_input"]).set_input_files(video_path)
            except Exception as exc:
                emit_result(ok=False, error=f"投喂视频失败(视频号可能改版):{exc}")
                return 1

            # ③ 填标题/话题/描述 ──────────────────────────
            emit_progress("fill", 40, "填写标题、话题、描述…")
            try:
                await _fill_title_tags_desc(page, title, tags, desc)
            except Exception as exc:
                emit_result(ok=False, error=f"填写标题失败(视频号可能改版):{exc}")
                return 1

            # ④ 等视频上传完成 ────────────────────────────
            emit_progress("upload", 60, "等待视频转码上传完成…")
            if not await _wait_video_uploaded(page, video_path):
                emit_result(ok=False, error="视频上传超时未完成")
                return 1

            # ⑤ 原创声明(可选) ──────────────────────────
            await _apply_original_statement(page)

            # ⑥ 封面(可选) ──────────────────────────────
            if cover_path:
                await _set_cover(page, cover_path)

            # ⑦ 定时(可选) ──────────────────────────────
            if schedule_dt is not None:
                await _set_schedule(page, schedule_dt)

            # ⑧ 短标题(部分账号必填) ────────────────────
            await _set_short_title(page, title)

            # ⑨ 点发表,等跳作品列表页 ────────────────────
            emit_progress("publish", 90, "正在发布…")
            published_url = ""
            for _ in range(60):  # 最长约 60s
                try:
                    btn = page.locator(PUBLISH["publish_btn"])
                    if await btn.count():
                        await btn.click()
                    await page.wait_for_url(URLS["manage"], timeout=3000)
                    published_url = page.url
                    break
                except Exception:
                    if URLS["manage"] in page.url:
                        published_url = page.url
                        break
                    await asyncio.sleep(0.5)

            if not published_url:
                emit_result(ok=False, error="点了发表但未跳转作品列表页(可能仍有未填必填项)")
                return 1

            # 发布成功后刷新 storage_state(cookie 续期)
            try:
                await context.storage_state(path=str(state_path))
            except Exception:
                pass

            emit_progress("publish", 100, "发布成功")
            emit_result(ok=True, url=published_url)
            return 0
    except Exception as exc:
        log(f"[shipinhao] post crashed: {exc}")
        emit_result(ok=False, error=f"发布异常:{exc}")
        return 1
