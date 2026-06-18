# -*- coding: utf-8 -*-
"""快手网页发布内核(patchright,cp.kuaishou.com)。

三个动作,均按 base.emit_* 协议输出:
  login : 打开 passport 登录页 → 抓二维码 dataUrl → 轮询到上传页判成功 →
          storage_state 存 SAU_SESSION_DIR/kuaishou.json
  check : 用已存 storage_state 验 cookie 是否还有效 → emit result ok
  post  : 载入 storage_state → 上传页点上传按钮投喂视频 → 填描述/话题 → 等上传完 →
          (封面)(定时) → 点发布 + 确认发布 → 等跳作品管理页 → emit result ok + url

流程与选择器搬自 dreammis/social-auto-upload 的 ks_uploader/main.py(已在真实快手验证、已迁 patchright),
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
from ks_selectors import COVER, FILL, LOGIN, PUBLISH, SCHEDULE, UPLOAD, URLS

PLATFORM = "kuaishou"


# ── 公共:cookie 校验 ─────────────────────────────────────────────────────
async def _cookie_valid(page) -> bool:
    """打开上传页;未登录会渲染出"机构服务"落地导航(= 失效标志)。
    5s 内出现该标志 = cookie 失效;没出现 = 有效。

    ⚠️ 这与参考仓库 ks_uploader 的 _is_ks_cookie_invalid 一致:"机构服务"是
    *未登录* 落地页的标志,出现它说明被踢出了登录态,别搞反。
    """
    try:
        await page.goto(URLS["upload"], wait_until="domcontentloaded")
    except Exception as exc:
        log(f"[kuaishou] goto upload failed: {exc}")
        return False
    try:
        # 出现"机构服务"= 未登录落地页 = 失效
        await page.wait_for_selector(LOGIN["cookie_invalid_marker"], timeout=5000)
        return False
    except Exception:
        # 没出现失效标志 = 视为有效(参考仓库即此口径)
        return True


# ── login:扫码登录 ──────────────────────────────────────────────────────
async def _extract_qrcode_src(page) -> str:
    """抓登录二维码 img 的 src(data:image/png;base64,...)。"""
    login_form = page.locator(LOGIN["login_form"]).first
    await login_form.wait_for(state="visible", timeout=30000)

    qrcode_img = login_form.locator(LOGIN["qrcode_img"]).first
    # 二维码不可见时,点"切换登录方式"切到扫码 tab
    try:
        if not await qrcode_img.count() or not await qrcode_img.is_visible():
            switch = login_form.locator(LOGIN["platform_switch"]).first
            await switch.wait_for(state="visible", timeout=10000)
            await switch.click()
            await asyncio.sleep(1)
    except Exception:
        switch = login_form.locator(LOGIN["platform_switch"]).first
        if await switch.count():
            await switch.click()
            await asyncio.sleep(1)

    await qrcode_img.wait_for(state="visible", timeout=15000)
    src = await qrcode_img.get_attribute("src")
    if not src:
        raise RuntimeError("未抓到快手登录二维码 src")
    return src


async def _is_login_page_gone(page) -> bool:
    """登录表单消失 = 已登录(快手登录后会跳出 passport 页)。"""
    try:
        login_form = page.locator(LOGIN["login_form"]).first
        if not await login_form.count():
            return True
        return not await login_form.is_visible()
    except Exception:
        return True


async def _is_qrcode_expired(page) -> bool:
    try:
        box = page.locator(LOGIN["qrcode_expired"]).first
        if not await box.count():
            return False
        return await box.is_visible()
    except Exception:
        return False


async def login() -> int:
    """打开快手登录页扫码。成功存 storage_state 并返回 0,失败返回 1。"""
    state_path = storage_state_path(PLATFORM)
    try:
        async with persistent_context(PLATFORM) as (context, page):
            emit_status("waiting", "正在打开快手创作者平台…")

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
            emit_status("waiting", "二维码已就绪,请用快手 App 扫码")

            # 轮询登录态(约 5 分钟:100 次 × 3s)
            poll_interval, max_checks = 3, 100
            for _ in range(max_checks):
                # 登录成功 = 已跳到 cp 上传页,或 passport 登录表单消失
                if page.url.startswith(URLS["upload"]) or await _is_login_page_gone(page):
                    await asyncio.sleep(1.5)
                    await context.storage_state(path=str(state_path))
                    if await _cookie_valid(page):
                        emit_status("success", "扫码登录成功")
                        return 0
                    emit_status("error", "扫码流程结束但 cookie 校验失败")
                    return 1

                # 二维码失效 → 自动刷新并重抓
                try:
                    if await _is_qrcode_expired(page):
                        emit_status("expired", "二维码已失效,正在刷新…")
                        refresh = page.locator(LOGIN["qrcode_refresh"]).first
                        if await refresh.count():
                            await refresh.click()
                            await asyncio.sleep(1)
                        src = await _extract_qrcode_src(page)
                        emit_qrcode(src)
                        emit_status("waiting", "新二维码已就绪,请重新扫码")
                except Exception:
                    pass

                await asyncio.sleep(poll_interval)

            emit_status("expired", "等待扫码超时")
            return 1
    except Exception as exc:
        log(f"[kuaishou] login crashed: {exc}")
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
        log(f"[kuaishou] check crashed: {exc}")
        emit_result(ok=False)
        return 0


# ── post:发布视频 ───────────────────────────────────────────────────────
async def _close_guide_overlay(page):
    """关掉 react-joyride 新手引导遮罩(挡住后续操作)。"""
    try:
        tip = page.locator(UPLOAD["joyride_tooltip"])
        if await tip.count() and await tip.first.is_visible():
            close_btn = page.locator('div[role="alertdialog"]').locator(
                UPLOAD["joyride_skip_btn"]
            )
            await close_btn.click(force=True)
            await tip.wait_for(state="hidden", timeout=5000)
            log("[kuaishou] joyride overlay closed")
    except Exception as exc:
        log(f"[kuaishou] close guide overlay skip: {exc}")


async def _click_know_btn(page):
    """点掉上传后可能弹的"我知道了"。"""
    try:
        btn = page.locator(UPLOAD["know_btn"]).first
        if await btn.count() and await btn.is_visible():
            await btn.click()
    except Exception:
        pass


async def _fill_desc_and_tags(page, desc: str, tags: list):
    """填描述 + 话题(话题逐个 #tag 空格触发,最多 3 个)。"""
    anchor = page.get_by_text(FILL["desc_anchor_text"]).locator(
        "xpath=following-sibling::div"
    )
    await anchor.click()
    await page.keyboard.press("Backspace")
    await page.keyboard.press("Control+KeyA")
    await page.keyboard.press("Delete")
    await page.keyboard.type(desc or "")
    await page.keyboard.press("Enter")

    for tag in (tags or [])[:3]:
        tag = str(tag).lstrip("#").strip()
        if not tag:
            continue
        await page.keyboard.type("#" + tag + " ")
        await asyncio.sleep(2)


async def _wait_video_uploaded(page, video_path: str, timeout_s: int = 600):
    """等视频上传完成("上传中"文字消失),失败自动重传一次。"""
    loops = max(1, timeout_s // 2)
    for i in range(loops):
        try:
            if await page.locator(UPLOAD["uploading_text"]).count() == 0:
                emit_progress("upload", 100, "视频已上传完成")
                return True
            if await page.locator(UPLOAD["upload_failed_text"]).count():
                emit_progress("upload", 50, "检测到上传失败,正在重传…")
                try:
                    await page.locator(UPLOAD["reupload_input"]).set_input_files(video_path)
                except Exception as exc:
                    log(f"[kuaishou] reupload failed: {exc}")
            else:
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
        cover_label = page.locator("span").filter(has_text=COVER["cover_label_text"])
        await cover_label.wait_for(state="visible", timeout=30000)
        await cover_label.locator("xpath=../following-sibling::div[1]").locator(
            "div"
        ).nth(0).click()

        modal = page.locator(COVER["cover_modal"])
        await modal.wait_for(state="visible", timeout=30000)

        upload_tab = modal.get_by_text(COVER["upload_cover_tab_text"], exact=True)
        await upload_tab.wait_for(state="visible", timeout=10000)
        await upload_tab.click()

        file_input = modal.locator(COVER["cover_file_input"])
        await file_input.wait_for(state="attached", timeout=30000)
        await file_input.set_input_files(cover_path)
        await asyncio.sleep(1)

        confirm = modal.get_by_role("button", name=COVER["cover_confirm_btn_name"], exact=True)
        await confirm.wait_for(state="visible", timeout=10000)
        await confirm.click()
        await modal.wait_for(state="hidden", timeout=30000)
        log("[kuaishou] cover set done")
    except Exception as exc:
        log(f"[kuaishou] set cover failed (skip): {exc}")


async def _set_schedule(page, schedule_dt):
    """设定时发布(ant DatePicker 受控组件,用 native setter + bubbling event)。"""
    try:
        await page.locator("label.ant-radio-wrapper").filter(
            has_text=SCHEDULE["radio_scheduled_text"]
        ).click()
        await asyncio.sleep(2)
        await page.locator(SCHEDULE["datetime_input"]).click()
        await asyncio.sleep(1)

        value = schedule_dt.strftime(SCHEDULE["datetime_format"])
        js = """
        (newValue) => {
            const input = document.querySelector('input[placeholder="选择日期时间"]');
            if (!input) return false;
            const nativeSetter = Object.getOwnPropertyDescriptor(
                window.HTMLInputElement.prototype, 'value'
            ).set;
            nativeSetter.call(input, newValue);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        }
        """
        ok = await page.evaluate(js, value)
        if not ok:
            log("[kuaishou] schedule input not found")
            return
        await asyncio.sleep(1)
        await page.keyboard.press("Enter")
        await asyncio.sleep(2)
        log(f"[kuaishou] schedule set to {value}")
    except Exception as exc:
        log(f"[kuaishou] set schedule failed (will publish immediately): {exc}")


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
            # cookie 失效拦截
            if not await _cookie_valid(page):
                emit_result(ok=False, error="登录已失效,请重新扫码登录")
                return 1

            # ① 进上传页 ─────────────────────────────────
            emit_progress("upload", 5, "进入上传页…")
            await page.goto(URLS["upload"], wait_until="domcontentloaded")
            await page.wait_for_url(URLS["upload_glob"], timeout=15000)

            # ② 点上传按钮投喂视频(快手走 file_chooser) ────
            emit_progress("upload", 15, "正在投喂视频文件…")
            upload_btn = page.locator(UPLOAD["upload_btn"])
            try:
                await upload_btn.wait_for(state="visible", timeout=10000)
            except Exception:
                emit_result(ok=False, error="未找到上传按钮(快手可能改版)")
                return 1
            async with page.expect_file_chooser() as fc_info:
                await upload_btn.click()
            file_chooser = await fc_info.value
            await file_chooser.set_files(video_path)
            await asyncio.sleep(2)

            # ③ 关掉引导提示 ──────────────────────────────
            await _click_know_btn(page)
            await _close_guide_overlay(page)

            # ④ 填描述/话题 ───────────────────────────────
            emit_progress("fill", 40, "填写描述、话题…")
            try:
                await _fill_desc_and_tags(page, desc, tags)
            except Exception as exc:
                emit_result(ok=False, error=f"填写描述失败(快手可能改版):{exc}")
                return 1

            # ⑤ 等视频上传完成 ────────────────────────────
            emit_progress("upload", 60, "等待视频转码上传完成…")
            if not await _wait_video_uploaded(page, video_path):
                emit_result(ok=False, error="视频上传超时未完成")
                return 1

            # ⑥ 封面(可选) ──────────────────────────────
            if cover_path:
                await _set_cover(page, cover_path)

            # ⑦ 定时(可选) ──────────────────────────────
            if schedule_dt is not None:
                await _set_schedule(page, schedule_dt)

            # ⑧ 点发布 + 确认发布,等跳作品管理页 ──────────
            emit_progress("publish", 90, "正在发布…")
            published_url = ""
            for _ in range(60):  # 最长约 60s
                try:
                    publish_btn = page.get_by_text(PUBLISH["publish_btn_text"], exact=True)
                    if await publish_btn.count():
                        await publish_btn.click()
                    await asyncio.sleep(1)
                    confirm_btn = page.get_by_text(PUBLISH["confirm_publish_text"])
                    if await confirm_btn.count():
                        await confirm_btn.click()
                    await page.wait_for_url(URLS["manage_glob"], timeout=3000)
                    published_url = page.url
                    break
                except Exception:
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
        log(f"[kuaishou] post crashed: {exc}")
        emit_result(ok=False, error=f"发布异常:{exc}")
        return 1
