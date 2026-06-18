# -*- coding: utf-8 -*-
"""小红书网页发布内核(patchright,creator.xiaohongshu.com)。

小红书发的是"笔记"。本内核默认发视频笔记;若 payload 不带视频、带 imagePaths/coverPath
则可发图文笔记。

【为什么走创作者后台网页,而不是 API/逆向库】
  小红书没有开放给商家的官方"代发布"接口。ReaJason/xhs 库那条路是逆向 web 签名
  (window._webmsxyw + Flask 签名服务),灰产味重、极易触发风控封号——本项目不走。
  本内核改走"创作者后台网页 + 人扫码 + 人点确认"的半自动路径(等同真人手动发),最稳最合规,
  与抖音/快手/视频号三家完全同构(同一套协议、同一个 patchright 持久上下文底座)。

三个动作,均按 base.emit_* 协议输出:
  login : 打开创作者登录页 → 切"扫一扫" → 抓二维码 dataUrl → 轮询登录框消失判成功 →
          storage_state 存 SAU_SESSION_DIR/xiaohongshu.json
  check : 用已存 storage_state 验 cookie 是否还有效 → emit result ok
  post  : 载入 storage_state → 视频发布页投喂视频 → 等上传完 → 填标题/正文/话题 →
          (封面)(原创声明)(定时) → 点发布 → 等跳成功页 → emit result ok + url

流程与选择器搬自 dreammis/social-auto-upload 的 xiaohongshu_uploader/main.py(已在真实小红书
创作者后台验证、用 patchright),反检测改用 base.persistent_context 持久上下文最佳实践
(不注入 stealth.min.js)。
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
from xhs_selectors import COVER, DECLARATION, FILL, LOGIN, PUBLISH, SCHEDULE, UPLOAD, URLS

PLATFORM = "xiaohongshu"


# ── 公共:cookie 校验 ─────────────────────────────────────────────────────
async def _cookie_valid(page) -> bool:
    """打开视频发布页;未登录会被 SPA 客户端 401 重定向回 /login(带 redirectReason=401)
    或弹登录框 = 失效。只有真出现发布页编辑控件(上传区 / 标题框)才算有效。

    ⚠️ 重定向是 SPA 客户端跳的、发生在 domcontentloaded 之后,所以必须给足时间让它落定,
    不能 goto 完立刻判 page.url(会误判成"已登录")。
    """
    try:
        await page.goto(URLS["publish_video"], wait_until="domcontentloaded")
    except Exception as exc:
        log(f"[xiaohongshu] goto publish failed: {exc}")
        return False

    # 等 SPA 把"未登录→/login"的客户端重定向跑完(轮询最多 ~8s)
    for _ in range(16):
        await page.wait_for_timeout(500)
        if page.url.startswith(URLS["login"]):
            return False
        try:
            login_box = page.locator(LOGIN["login_box"]).first
            if await login_box.count() and await login_box.is_visible():
                return False
        except Exception:
            pass
        # 出现发布页编辑控件 = 真登录态
        try:
            for sel in (FILL["title_input"], UPLOAD["video_input"], "div[class^='upload-content']"):
                if await page.locator(sel).first.count():
                    return True
        except Exception:
            pass

    # 8s 内既没被踢回 login,也没等到编辑控件:保守按未登录处理,避免误放行
    log("[xiaohongshu] cookie check inconclusive (no editor controls), treat as invalid")
    return False


# ── login:扫码登录 ──────────────────────────────────────────────────────
async def _open_qrcode_panel(page):
    """切到"扫一扫"二维码登录 tab。"""
    login_box = page.locator(LOGIN["login_box"]).first
    await login_box.wait_for(state="visible", timeout=30000)

    if await login_box.locator(LOGIN["scan_text"]).first.count():
        return

    switch = login_box.locator(LOGIN["switch_img"]).first
    await switch.wait_for(state="visible", timeout=10000)
    await switch.click()
    await login_box.locator(LOGIN["scan_text"]).first.wait_for(state="visible", timeout=10000)


def _qrcode_locator(page):
    """扫一扫区域里的二维码 img locator。"""
    return (
        page.locator(LOGIN["login_box_container"])
        .get_by_text(LOGIN["scan_anchor_text"])
        .filter(visible=True)
        .locator(LOGIN["qrcode_img_xpath"])
        .nth(0)
    )


async def _extract_qrcode_src(page) -> str:
    await _open_qrcode_panel(page)
    img = _qrcode_locator(page)
    if not await img.count():
        raise RuntimeError("未在扫一扫登录区域找到小红书二维码图片")
    await img.wait_for(state="visible", timeout=30000)
    src = await img.get_attribute("src")
    if not src:
        raise RuntimeError("未抓到小红书登录二维码 src")
    return src


async def _is_login_completed(page) -> bool:
    """登录成功 = 不再停在登录页 且 登录框不可见。"""
    if page.url.startswith(URLS["login"]):
        return False
    login_box = page.locator(LOGIN["login_box"]).first
    if not await login_box.count():
        return True
    try:
        return not await login_box.is_visible()
    except Exception:
        return True


async def login() -> int:
    """打开小红书创作者后台扫码登录。成功存 storage_state 并返回 0,失败返回 1。

    小红书二维码 src 多为 data:image/...(直接透传);少数情况是普通 URL,
    此时退化为对二维码 img 截图、转 data URL 发给前端。
    """
    state_path = storage_state_path(PLATFORM)
    try:
        async with persistent_context(PLATFORM) as (context, page):
            emit_status("waiting", "正在打开小红书创作者后台…")

            # 若已登录(持久 profile 还留着 session),直接落 state 收工
            if await _cookie_valid(page):
                await context.storage_state(path=str(state_path))
                emit_status("success", "已是登录态,无需扫码")
                return 0

            await page.goto(URLS["login"], wait_until="domcontentloaded")

            try:
                src = await _extract_qrcode_src(page)
                data_url = await _to_data_url(page, src)
            except Exception as exc:
                emit_status("error", f"抓二维码失败:{exc}")
                return 1

            emit_qrcode(data_url)
            emit_status("waiting", "二维码已就绪,请用小红书 App 扫码")

            # 轮询登录态(约 5 分钟:100 次 × 3s)
            poll_interval, max_checks = 3, 100
            for _ in range(max_checks):
                if await _is_login_completed(page):
                    await asyncio.sleep(2)
                    await context.storage_state(path=str(state_path))
                    if await _cookie_valid(page):
                        emit_status("success", "扫码登录成功")
                        return 0
                    emit_status("error", "扫码流程结束但 cookie 校验失败")
                    return 1
                await asyncio.sleep(poll_interval)

            emit_status("expired", "等待扫码超时")
            return 1
    except Exception as exc:
        log(f"[xiaohongshu] login crashed: {exc}")
        emit_status("error", f"登录进程异常:{exc}")
        return 1


async def _to_data_url(page, src: str) -> str:
    """src 已是 data: 直接用;否则对二维码 img 截图转 data URL(协议要 dataUrl)。"""
    if src.startswith("data:image/"):
        return src
    try:
        import base64

        img = _qrcode_locator(page)
        png = await img.screenshot()
        return "data:image/png;base64," + base64.b64encode(png).decode("ascii")
    except Exception as exc:
        log(f"[xiaohongshu] screenshot qrcode failed, fallback to raw src: {exc}")
        return src


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
        log(f"[xiaohongshu] check crashed: {exc}")
        emit_result(ok=False)
        return 0


# ── post:发布笔记 ───────────────────────────────────────────────────────
async def _fill_title(page, title: str):
    box = page.locator(FILL["title_input"])
    await box.fill((title or "")[: FILL["title_max"]])


async def _fill_desc(page, desc: str):
    if not desc:
        return
    editor = page.locator(FILL["desc_editor"])
    await editor.click()
    await page.keyboard.press("Backspace")
    await page.keyboard.press("Control+KeyA")
    await page.keyboard.press("Delete")
    await page.keyboard.type(desc)
    await page.keyboard.press("Enter")


async def _fill_tags(page, tags: list, has_desc: bool):
    """填话题(逐个走小红书联想下拉;上限 10 个,等不到候选就跳过该标签)。"""
    if not tags:
        return
    tags = [str(t).lstrip("#").strip() for t in tags if str(t).strip()]
    if len(tags) > FILL["tags_max"]:
        log(f"[xiaohongshu] tags {len(tags)} 超上限,截断为 {FILL['tags_max']}")
        tags = tags[: FILL["tags_max"]]

    if not has_desc:
        await page.locator(FILL["desc_editor"]).click()

    for tag in tags:
        try:
            await page.keyboard.type("#" + tag, delay=30)
            await page.locator(FILL["topic_container"]).wait_for(state="visible", timeout=6000)
            first = page.locator(FILL["topic_first_item"]).first
            await first.wait_for(state="visible", timeout=4000)
            await first.click()
        except Exception as exc:
            log(f"[xiaohongshu] 话题『{tag}』无候选,跳过: {exc}")
            # 清掉未成词的 "#tag" 文本,避免残留进正文
            for _ in range(len("#" + tag)):
                await page.keyboard.press("Backspace")
            continue


async def _wait_video_uploaded(page, timeout_s: int = 600):
    """等视频上传完成(预览区出现完成关键字,或标题框出现)。"""
    loops = max(1, timeout_s // 2)
    for i in range(loops):
        try:
            upload_input = await page.wait_for_selector(UPLOAD["preview_input"], timeout=3000)
            preview = await upload_input.query_selector(UPLOAD["preview_new_xpath"])
            if preview:
                text = await preview.inner_text()
                done = any(k in text for k in UPLOAD["done_keywords"])
                if not done:
                    stages = await preview.query_selector_all(UPLOAD["stage_div"])
                    for st in stages:
                        tc = await page.evaluate("(e) => e.textContent", st)
                        if "上传成功" in tc or "分辨率" in tc:
                            done = True
                            break
                if done:
                    emit_progress("upload", 100, "视频已上传完成")
                    return True
            else:
                # 标题框出现 = 已进编辑态
                title_box = page.locator(FILL["title_input"])
                if await title_box.count() and await title_box.is_visible():
                    emit_progress("upload", 100, "已进入编辑态")
                    return True
        except Exception:
            pass
        pct = min(90, 30 + int(i / loops * 60))
        emit_progress("upload", pct, "视频上传中…")
        await asyncio.sleep(2)
    return False


async def _set_cover(page, cover_path: str):
    if not cover_path or not Path(cover_path).exists():
        return
    try:
        emit_progress("fill", 80, "正在设置封面…")
        plugin_title = page.locator("div.cover-plugin-title").filter(
            has_text=COVER["cover_plugin_title_text"]
        )
        default = plugin_title.locator(
            "xpath=ancestor::div[contains(@class, 'cover-plugin-preview')]"
        ).locator(COVER["cover_default_visible"])
        await default.wait_for(state="visible", timeout=30000)
        await default.click(force=True)

        modal = page.locator(COVER["cover_modal"])
        await modal.wait_for(state="visible", timeout=30000)

        file_input = modal.locator(COVER["cover_file_input"]).first
        await file_input.wait_for(state="attached", timeout=10000)
        await file_input.set_input_files(cover_path)
        await page.wait_for_timeout(2000)

        confirm = modal.locator(COVER["cover_confirm_btn"]).filter(
            has_text=COVER["cover_confirm_text"]
        ).first
        await confirm.wait_for(state="visible", timeout=10000)
        await confirm.click()
        await modal.wait_for(state="hidden", timeout=30000)
        log("[xiaohongshu] cover set done")
    except Exception as exc:
        log(f"[xiaohongshu] set cover failed (skip): {exc}")


async def _check_original_declaration(page):
    """勾选原创声明(若页面有)。"""
    try:
        cb = page.locator(DECLARATION["checkbox"]).first
        if await cb.count() and not await cb.is_checked():
            await cb.check()
            log("[xiaohongshu] original declaration checked")
            return
        txt = page.locator(DECLARATION["text"]).first
        if await txt.count():
            await txt.click()
            log("[xiaohongshu] original declaration clicked")
    except Exception as exc:
        log(f"[xiaohongshu] original declaration skip: {exc}")


async def _set_schedule(page, schedule_dt):
    try:
        await page.locator(SCHEDULE["switch"]).filter(
            has_text=SCHEDULE["switch_text"]
        ).locator(SCHEDULE["switch_toggle"]).click()
        await asyncio.sleep(1)
        value = schedule_dt.strftime(SCHEDULE["datetime_format"])
        await page.locator(SCHEDULE["time_input"]).fill(value)
        await asyncio.sleep(1)
        log(f"[xiaohongshu] schedule set to {value}")
    except Exception as exc:
        log(f"[xiaohongshu] set schedule failed (will publish immediately): {exc}")


async def post(payload: dict) -> int:
    """发布一条视频笔记。payload = {videoPath,title,tags[],coverPath?,scheduleAt?,desc?}。"""
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

            # ① 进视频发布页 ─────────────────────────────
            emit_progress("upload", 5, "进入视频发布页…")
            await page.goto(URLS["publish_video"], wait_until="domcontentloaded")
            await page.wait_for_url(URLS["publish_video"], timeout=15000)

            # ② 投喂视频 ──────────────────────────────────
            emit_progress("upload", 15, "正在投喂视频文件…")
            try:
                await page.locator(UPLOAD["video_input"]).set_input_files(video_path)
            except Exception as exc:
                emit_result(ok=False, error=f"投喂视频失败(小红书可能改版):{exc}")
                return 1

            # ③ 等视频上传完成 ────────────────────────────
            emit_progress("upload", 40, "等待视频转码上传完成…")
            if not await _wait_video_uploaded(page):
                emit_result(ok=False, error="视频上传超时未完成")
                return 1

            # ④ 填标题/正文/话题 ──────────────────────────
            emit_progress("fill", 55, "填写标题、正文、话题…")
            try:
                await _fill_title(page, title)
                await _fill_desc(page, desc)
                await _fill_tags(page, tags, has_desc=bool(desc))
            except Exception as exc:
                emit_result(ok=False, error=f"填写内容失败(小红书可能改版):{exc}")
                return 1

            # ⑤ 封面(可选) ──────────────────────────────
            if cover_path:
                await _set_cover(page, cover_path)

            # ⑥ 原创声明 ──────────────────────────────────
            await _check_original_declaration(page)

            # ⑦ 定时(可选) ──────────────────────────────
            if schedule_dt is not None:
                await _set_schedule(page, schedule_dt)

            # ⑧ 点发布,等跳成功页 ────────────────────────
            emit_progress("publish", 90, "正在发布…")
            published_url = ""
            btn_sel = (
                PUBLISH["schedule_publish_btn"] if schedule_dt is not None else PUBLISH["publish_btn"]
            )
            for _ in range(60):  # 最长约 30s
                try:
                    btn = page.locator(btn_sel)
                    if await btn.count():
                        await btn.click()
                    await page.wait_for_url(URLS["success_glob"], timeout=3000)
                    published_url = page.url
                    break
                except Exception:
                    if URLS["success_url"] in page.url:
                        published_url = page.url
                        break
                    await asyncio.sleep(0.5)

            if not published_url:
                emit_result(ok=False, error="点了发布但未跳转成功页(可能仍有未填必填项)")
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
        log(f"[xiaohongshu] post crashed: {exc}")
        emit_result(ok=False, error=f"发布异常:{exc}")
        return 1
