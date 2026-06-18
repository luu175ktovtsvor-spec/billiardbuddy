# -*- coding: utf-8 -*-
"""视频号(微信)发布的【集中选择器表】(sph_selectors.py)。

平台域名 channels.weixin.qq.com(视频号助手),后台称"视频号 = tencent"。

⚠️ 文件名特意不叫 selectors.py:cli.py 以本目录为 cwd 运行,
   与标准库 selectors 撞名会让 asyncio 崩(asyncio 内部会 import selectors)。

⚠️ 平台改版只改这里,业务逻辑(shipinhao_uploader.py)不动。
来源:dreammis/social-auto-upload(12.7k★)的 uploader/tencent_uploader/main.py,
其中的选择器是该仓库在真实视频号助手验证过的(2026 年现行版,已迁 patchright),
本文件做了原样搬运 + 注释。
"""

from __future__ import annotations

# ── 入口 URL ─────────────────────────────────────────────────────────────
URLS = {
    # 登录入口(首页;扫码在内嵌 iframe)
    "login": "https://channels.weixin.qq.com",
    # 发表视频页(投喂视频 + 填信息 + 发表)
    "upload": "https://channels.weixin.qq.com/platform/post/create",
    # 发表成功后跳作品列表页
    "manage": "https://channels.weixin.qq.com/platform/post/list",
}


# ── 登录(扫码,二维码在 iframe 里) ──────────────────────────────────────
LOGIN = {
    # 扫码登录用的 iframe(src 含 login-for-iframe)
    "iframe_src_match": '[src*="login-for-iframe"]',
    # iframe 内二维码 img
    "iframe_qrcode_img": "div#app img.qrcode",
    # iframe 抓不到时的页面级二维码兜底选择器(按序尝试)
    "qrcode_fallbacks": [
        "div.login-qrcode-wrap img.qrcode",
        "div.qrcode-wrap img.qrcode",
        "img.qrcode",
        'img[src^="data:image/"]',
    ],
    # 登录成功标志(发表/草稿按钮出现)
    "login_done_markers": [
        'div:has-text("发表视频")',
        'button:has-text("发表")',
        'button:has-text("保存草稿")',
    ],
    # 未登录标志(二维码区还在)
    "login_box_markers": [
        "div.login-qrcode-wrap",
        "div.qrcode-wrap",
        "img.qrcode",
        'span:has-text("微信扫码登录 视频号助手")',
    ],
    # cookie 失效标志:上传页出现"扫码登录"
    "cookie_invalid_text": "扫码登录",
    # 二维码失效提示(点它刷新)
    "expired_tips": [
        'div.mask.show p.refresh-tip:has-text("二维码已过期，点击刷新")',
        'div.mask.show p.refresh-tip:has-text("网络不可用，点击刷新")',
        'p.refresh-tip:has-text("二维码已过期，点击刷新")',
        'p.refresh-tip:has-text("网络不可用，点击刷新")',
    ],
    # 二维码失效后可点的刷新区域
    "refresh_wraps": [
        "div.login-qrcode-wrap div.mask.show div.refresh-wrap",
        "div.login-qrcode-wrap div.mask.show .refresh-wrap",
        "div.login-qrcode-wrap div.refresh-wrap",
    ],
    # 已扫码、待手机确认提示
    "scanned_tips": [
        'div.qr-tip div:has-text("已扫码")',
        'div.qr-tip div:has-text("需在手机上进行确认")',
    ],
}


# ── 上传(投喂视频文件) ──────────────────────────────────────────────────
UPLOAD = {
    # 视频文件 input
    "video_file_input": 'input[type="file"]',
    # 上传完成判定:发表按钮可点(class 不含 disabled)
    "publish_btn_name": "发表",
    "publish_btn_disabled_cls": "weui-desktop-btn_disabled",
    # 上传失败标志 + 删除标签(用于重传)
    "upload_failed_marker": "div.status-msg.error",
    "delete_tag": 'div.media-status-content div.tag-inner:has-text("删除")',
    "delete_confirm_btn_name": "删除",
}


# ── 填写标题/描述/话题 ───────────────────────────────────────────────────
FILL = {
    # 标题/正文编辑器(contenteditable)
    "editor": "div.input-editor",
    # 短标题(从"短标题"文字后取 input)
    "short_title_anchor": "短标题",
    "short_title_input": 'span input[type="text"]',
}


# ── 封面(可选,横/竖) ───────────────────────────────────────────────────
COVER = {
    "landscape_selectors": [
        'div.horizontal-cover-wrap:has-text("4:3")',
        'div[class*="cover-wrap"]:has-text("4:3"):has-text("动态")',
        'div:has-text("视频号动态"):has-text("4:3")',
        'div:has-text("横版封面"):has-text("4:3")',
    ],
    "portrait_selectors": [
        'div.vertical-cover-wrap:has-text("个人主页卡片"):has-text("3:4")',
        'div.vertical-cover-wrap:has-text("3:4")',
        'div.vertical-cover-wrap:has-text("个人主页卡片")',
    ],
    "dialog_titles_landscape": ["编辑视频号动态封面", "编辑动态封面", "编辑封面"],
    "dialog_titles_portrait": ["编辑个人主页卡片", "编辑封面"],
    "cover_file_input": '.single-cover-uploader-wrap input[type="file"]',
    "crop_dialog_title": "裁剪封面图",
    "crop_confirm_btn": 'div.weui-desktop-dialog__ft button.weui-desktop-btn_primary:has-text("确定")',
    "confirm_btn": 'div.weui-desktop-dialog__ft button.weui-desktop-btn_primary:has-text("确认")',
}


# ── 定时发布 ─────────────────────────────────────────────────────────────
SCHEDULE = {
    "label_text": "定时",
    "date_input": 'input[placeholder="请选择发表时间"]',
    "time_input": 'input[placeholder="请选择时间"]',
    "month_label": 'span.weui-desktop-picker__panel__label:has-text("月")',
    "next_month_btn": "button.weui-desktop-btn__icon__right",
    "picker_days": "table.weui-desktop-picker__table a",
    "picker_day_disabled_cls": "weui-desktop-picker__disabled",
}


# ── 发布按钮 ─────────────────────────────────────────────────────────────
PUBLISH = {
    "publish_btn": 'div.form-btns button:has-text("发表")',
    "manage_url_match": "**/post/list**",
}
