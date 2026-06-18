# -*- coding: utf-8 -*-
"""抖音网页发布内核(patchright,creator.douyin.com)。

三个动作,均按 base.emit_* 协议输出:
  login : 打开创作者后台 → 抓二维码 dataUrl → 轮询到 creator-micro/home 判成功 →
          storage_state 存 SAU_SESSION_DIR/douyin.json
  check : 用已存 storage_state 验 cookie 是否还有效 → emit result ok
  post  : 载入 storage_state → 上传页投喂视频 → 进发布页 → 填标题/话题/封面/(定时) → 点发布 →
          等跳作品管理页 → emit result ok + url

流程与选择器搬自 dreammis/social-auto-upload 的 douyin_uploader/main.py(已在真实抖音验证),
反检测改用 patchright 持久上下文最佳实践(不注入 stealth.min.js)。
"""

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
# 注意:模块名特意不叫 selectors.py —— 会和 Python 标准库 selectors 撞名,
# 而 cli.py 以 publisher 目录为 cwd 运行,撞名会让 asyncio(内部 import selectors)崩。
from dy_selectors import (
    COVER,
    DECLARATION,
    FILL,
    LOGIN,
    PUBLISH,
    SCHEDULE,
    UPLOAD,
    URLS,
)

PLATFORM = "douyin"


# ── 公共:cookie 校验 ─────────────────────────────────────────────────────
async def _cookie_valid(page) -> bool:
    """打开上传页,出现登录字样 = 失效;停在上传页 = 有效。"""
    try:
        await page.goto(URLS["upload"], wait_until="domcontentloaded")
    except Exception as exc:
        log(f"[douyin] goto upload failed: {exc}")
        return False

    # 给前端 SPA 一点渲染时间
    try:
        await page.wait_for_url(URLS["upload"], timeout=6000)
    except Exception:
        # URL 可能被重定向到登录页
        pass

    for t in LOGIN["need_login_texts"]:
        try:
            if await page.get_by_text(t).count():
                return False
        except Exception:
            continue
    # 上传控件在 = 真在上传页
    try:
        return await page.locator(UPLOAD["video_file_input"]).count() > 0
    except Exception:
        return False


# ── login:扫码登录 ──────────────────────────────────────────────────────
async def _extract_qrcode_src(page) -> str:
    """抓登录二维码 img 的 src(通常是 data:image/png;base64,...)。"""
    scan_tab = page.get_by_text(LOGIN["scan_tab_text"], exact=True).first
    await scan_tab.wait_for(timeout=30000)

    # tab 同级后一个 div 内的二维码 img
    qrcode_img = (
        scan_tab.locator("..")
        .locator("xpath=following-sibling::div[1]")
        .locator(LOGIN["qrcode_img_aria"])
        .first
    )
    if not await qrcode_img.count():
        qrcode_img = page.get_by_role("img", name=LOGIN["qrcode_img_role_name"]).first

    await qrcode_img.wait_for(state="visible", timeout=30000)
    src = await qrcode_img.get_attribute("src")
    if not src:
        raise RuntimeError("未抓到抖音登录二维码 src")
    return src


async def _is_login_completed(page) -> bool:
    """登录成功 = URL 进 creator-micro/home 且页面上没有任何登录标志可见。"""
    if not page.url.startswith(URLS["login_ok_prefix"]):
        return False
    markers = [
        page.get_by_text(LOGIN["scan_tab_text"], exact=True).first,
        page.get_by_text("手机号登录", exact=True).first,
        page.get_by_text(LOGIN["qrcode_expired_text"], exact=True).first,
        page.get_by_role("img", name=LOGIN["qrcode_img_role_name"]).first,
    ]
    for m in markers:
        try:
            if await m.count() and await m.is_visible():
                return False
        except Exception:
            continue
    return True


async def login() -> int:
    """打开创作者后台扫码登录。成功存 storage_state 并返回 0,失败返回 1。"""
    state_path = storage_state_path(PLATFORM)
    try:
        async with persistent_context(PLATFORM) as (context, page):
            emit_status("waiting", "正在打开抖音创作者后台…")
            await page.goto(URLS["home"], wait_until="domcontentloaded")

            # 若已登录(持久 profile 里还留着 session),直接落 state、收工
            if await _is_login_completed(page) or await _cookie_valid(page):
                await context.storage_state(path=str(state_path))
                emit_status("success", "已是登录态,无需扫码")
                return 0

            # 回到首页抓二维码(_cookie_valid 可能把页面带到了 upload)
            if not page.url.startswith(URLS["home"]):
                await page.goto(URLS["home"], wait_until="domcontentloaded")

            try:
                src = await _extract_qrcode_src(page)
            except Exception as exc:
                emit_status("error", f"抓二维码失败:{exc}")
                return 1

            emit_qrcode(src)
            emit_status("waiting", "二维码已就绪,请用抖音 App 扫码")

            # 轮询登录态(约 5 分钟:100 次 × 3s)
            poll_interval, max_checks = 3, 100
            scanned_announced = False
            for _ in range(max_checks):
                if await _is_login_completed(page):
                    await asyncio.sleep(1.5)
                    await context.storage_state(path=str(state_path))
                    # 二次校验 cookie 真有效
                    if await _cookie_valid(page):
                        emit_status("success", "扫码登录成功")
                        return 0
                    emit_status("error", "扫码流程结束但 cookie 校验失败")
                    return 1

                # 二维码失效 → 自动点刷新并重抓
                try:
                    expired = page.get_by_text(
                        LOGIN["qrcode_expired_text"], exact=True
                    ).locator("..").first
                    if await expired.count() and await expired.is_visible():
                        emit_status("expired", "二维码已失效,正在刷新…")
                        await expired.click()
                        await asyncio.sleep(1)
                        src = await _extract_qrcode_src(page)
                        emit_qrcode(src)
                        emit_status("waiting", "新二维码已就绪,请重新扫码")
                except Exception:
                    pass

                # 抖音扫码后会先停在"确认登录"中间态,这里粗略提示一次 scanned
                if not scanned_announced and page.url.startswith(URLS["login_ok_prefix"]):
                    emit_status("scanned", "已扫码,等待确认…")
                    scanned_announced = True

                await asyncio.sleep(poll_interval)

            emit_status("expired", "等待扫码超时")
            return 1
    except Exception as exc:
        log(f"[douyin] login crashed: {exc}")
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
        log(f"[douyin] check crashed: {exc}")
        emit_result(ok=False)
        return 0


# ── post:发布视频 ───────────────────────────────────────────────────────
async def _fill_title_and_tags(page, title: str, tags: list, desc: str):
    """填标题 + 描述 + 话题(话题逐个 #tag 空格触发)。"""
    desc_section = (
        page.get_by_text(FILL["desc_anchor_text"], exact=True)
        .locator("xpath=ancestor::div[2]")
        .locator("xpath=following-sibling::div[1]")
    )

    title_input = desc_section.locator(FILL["title_input_in_section"]).first
    await title_input.wait_for(state="visible", timeout=10000)
    await title_input.fill((title or "")[:30])

    editor = desc_section.locator(FILL["desc_editor_in_section"]).first
    await editor.wait_for(state="visible", timeout=10000)
    await editor.click()
    await page.keyboard.press("Control+KeyA")
    await page.keyboard.press("Delete")
    if desc:
        await page.keyboard.type(desc)

    for tag in tags or []:
        tag = str(tag).lstrip("#").strip()
        if not tag:
            continue
        await page.keyboard.type(" #" + tag)
        await page.keyboard.press("Space")


async def _wait_video_uploaded(page, timeout_s: int = 600):
    """等视频上传完成(出现"重新上传"),失败自动重传一次。最长 timeout_s。"""
    loops = max(1, timeout_s // 2)
    for i in range(loops):
        try:
            if await page.locator(UPLOAD["upload_done_marker"]).count() > 0:
                emit_progress("upload", 100, "视频已上传完成")
                return True
            if await page.locator(UPLOAD["upload_failed_marker"]).count() > 0:
                emit_progress("upload", 50, "检测到上传失败,正在重传…")
                try:
                    await page.locator(UPLOAD["reupload_input"]).set_input_files(
                        page._sau_video_path  # set in post()
                    )
                except Exception as exc:
                    log(f"[douyin] reupload failed: {exc}")
            else:
                # 粗略进度(没有精确百分比,做个 30~90 的爬升提示)
                pct = min(90, 30 + int(i / loops * 60))
                emit_progress("upload", pct, "视频上传中…")
        except Exception:
            pass
        await asyncio.sleep(2)
    return False


async def _set_cover(page, cover_path: str):
    if not cover_path or not Path(cover_path).exists():
        return
    try:
        emit_progress("fill", 80, "正在设置封面…")
        await page.click(f'text="{COVER["choose_cover_text"]}"')
        modal = page.locator(COVER["cover_modal"])
        await page.wait_for_selector(COVER["cover_modal"], timeout=10000)
        upload_input = modal.locator(COVER["cover_upload_input"])
        await page.wait_for_timeout(1000)
        await upload_input.set_input_files(cover_path)
        await page.wait_for_timeout(2000)
        await modal.locator(COVER["cover_finish_btn"]).click()
        try:
            await page.wait_for_selector(
                COVER["cover_modal_footer_gone"], state="detached", timeout=8000
            )
        except Exception:
            pass
        log("[douyin] cover set done")
    except Exception as exc:
        log(f"[douyin] set cover failed (skip): {exc}")


async def _auto_pick_cover_if_required(page):
    """发布前若提示需设封面,自动选第一个推荐封面。"""
    try:
        need = page.get_by_text(COVER["need_cover_text"]).first
        if await need.count() and await need.is_visible():
            rec = page.locator(COVER["recommend_cover"]).first
            if await rec.count():
                await rec.click()
                await asyncio.sleep(1)
                confirm = page.get_by_text(COVER["cover_confirm_text"]).first
                if await confirm.count() and await confirm.is_visible():
                    await page.get_by_role(
                        "button", name=PUBLISH["confirm_btn_name"]
                    ).click()
                    await asyncio.sleep(1)
                return True
    except Exception as exc:
        log(f"[douyin] auto cover failed: {exc}")
    return False


async def _set_self_declaration(page):
    """选"自主声明"(抖音常为必选);失败仅记 warning,不中断发布。"""
    try:
        entry = page.get_by_text(DECLARATION["entry_text"]).first
        await entry.wait_for(state="visible", timeout=6000)
        await entry.click()
        dialog = page.locator(DECLARATION["dialog"]).filter(
            has_text=DECLARATION["dialog_title"]
        ).first
        await dialog.wait_for(state="visible", timeout=6000)
        decl = DECLARATION["default_declaration"]
        option = dialog.locator(DECLARATION["radio"]).filter(has_text=decl).first
        if await option.count():
            await option.click(timeout=6000)
        else:
            await dialog.get_by_text(decl, exact=True).first.click(timeout=6000, force=True)
        await dialog.get_by_role("button", name=PUBLISH["confirm_btn_name"]).click(timeout=6000)
        await dialog.wait_for(state="hidden", timeout=6000)
        log("[douyin] self declaration set")
    except Exception as exc:
        log(f"[douyin] self declaration skipped: {exc}")


async def _set_schedule(page, schedule_dt):
    """设定时发布(schedule_dt 为 datetime)。"""
    try:
        await page.locator(SCHEDULE["radio_scheduled"]).click()
        await asyncio.sleep(1)
        value = schedule_dt.strftime(SCHEDULE["datetime_format"])
        await page.locator(SCHEDULE["datetime_input"]).click()
        await page.keyboard.press("Control+KeyA")
        await page.keyboard.type(value)
        await page.keyboard.press("Enter")
        await asyncio.sleep(1)
        log(f"[douyin] schedule set to {value}")
    except Exception as exc:
        log(f"[douyin] set schedule failed (will publish immediately): {exc}")


async def _disable_third_part_sync(page):
    """关掉"同步到头条/西瓜"等第三方开关(默认不勾)。"""
    try:
        sw = page.locator(PUBLISH["third_part_switch"])
        if await sw.count():
            cls = await page.eval_on_selector(
                PUBLISH["third_part_switch"], "d => d.className"
            )
            if PUBLISH["third_part_switch_checked_cls"] in (cls or ""):
                await sw.locator(PUBLISH["third_part_native_input"]).click()
    except Exception as exc:
        log(f"[douyin] third-part switch skip: {exc}")


async def post(payload: dict) -> int:
    """发布一条视频。payload = {videoPath,title,tags[],coverPath?,scheduleAt?}。"""
    video_path = payload.get("videoPath")
    title = payload.get("title") or ""
    tags = payload.get("tags") or []
    cover_path = payload.get("coverPath") or ""
    schedule_at = payload.get("scheduleAt") or ""
    desc = payload.get("desc") or title

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
            page._sau_video_path = video_path  # 给重传步骤用

            # cookie 失效拦截
            if not await _cookie_valid(page):
                emit_result(ok=False, error="登录已失效,请重新扫码登录")
                return 1

            # ① 上传页投喂视频 ─────────────────────────────
            emit_progress("upload", 5, "进入上传页…")
            await page.goto(URLS["upload"], wait_until="domcontentloaded")
            await page.wait_for_url(URLS["upload"], timeout=15000)
            emit_progress("upload", 15, "正在投喂视频文件…")
            await page.locator(UPLOAD["video_file_input"]).set_input_files(video_path)

            # ② 等进入发布页(v1/v2 双兼容) ───────────────
            entered = False
            for _ in range(120):  # 最长约 60s
                for key in ("publish_v1", "publish_v2"):
                    try:
                        await page.wait_for_url(URLS[key], timeout=1500)
                        entered = True
                        log(f"[douyin] entered publish page: {key}")
                        break
                    except Exception:
                        continue
                if entered:
                    break
                await asyncio.sleep(0.5)
            if not entered:
                emit_result(ok=False, error="超时未进入发布页(抖音可能改版或网络慢)")
                return 1

            await asyncio.sleep(1)

            # ③ 填标题/描述/话题 ──────────────────────────
            emit_progress("fill", 40, "填写标题、描述、话题…")
            await _fill_title_and_tags(page, title, tags, desc)

            # ④ 等视频上传完成 ────────────────────────────
            emit_progress("upload", 60, "等待视频转码上传完成…")
            if not await _wait_video_uploaded(page):
                emit_result(ok=False, error="视频上传超时未完成")
                return 1

            # ⑤ 封面(可选) ──────────────────────────────
            if cover_path:
                await _set_cover(page, cover_path)

            # ⑥ 自主声明 + 关第三方同步 ───────────────────
            await _set_self_declaration(page)
            await _disable_third_part_sync(page)

            # ⑦ 定时(可选) ──────────────────────────────
            if schedule_dt is not None:
                await _set_schedule(page, schedule_dt)

            # ⑧ 点发布,等跳作品管理页 ─────────────────────
            emit_progress("publish", 90, "正在发布…")
            published_url = ""
            for _ in range(60):  # 最长约 30s
                try:
                    btn = page.get_by_role(
                        "button", name=PUBLISH["publish_btn_name"], exact=True
                    )
                    if await btn.count():
                        await btn.click()
                    await page.wait_for_url(URLS["manage_glob"], timeout=3000)
                    published_url = page.url
                    break
                except Exception:
                    # 可能卡在"请设置封面",自动补救
                    await _auto_pick_cover_if_required(page)
                    await asyncio.sleep(0.5)

            if not published_url:
                emit_result(ok=False, error="点了发布但未跳转作品管理页(可能仍有未填必填项)")
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
        log(f"[douyin] post crashed: {exc}")
        emit_result(ok=False, error=f"发布异常:{exc}")
        return 1
