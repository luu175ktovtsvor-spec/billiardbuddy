# -*- coding: utf-8 -*-
"""小红书创作者后台(creator.xiaohongshu.com)发布的【集中选择器表】(xhs_selectors.py)。

⚠️ 文件名特意不叫 selectors.py:cli.py 以本目录为 cwd 运行,
   与标准库 selectors 撞名会让 asyncio 崩(asyncio 内部会 import selectors)。

⚠️ 平台改版只改这里,业务逻辑(xiaohongshu_uploader.py)不动。
来源:dreammis/social-auto-upload(12.7k★)的 uploader/xiaohongshu_uploader/main.py
(走创作者后台网页流程,非官方 API;在真实小红书创作者后台验证过,已用 patchright)。
本文件做了原样搬运 + 注释。

【小红书无官方发布 API】小红书没有开放给商家的"代发布"接口;ReaJason/xhs 库走的是
逆向 web 签名(window._webmsxyw)、灰产味重且极易封号。本内核改走"创作者后台网页 +
人扫码 + 人确认"的半自动路径(等同真人在 creator.xiaohongshu.com 手动发),最稳、最合规。
小红书发的是"笔记":视频笔记 / 图文笔记。本内核默认发视频笔记(target=video)。
"""

from __future__ import annotations

# ── 入口 URL ─────────────────────────────────────────────────────────────
URLS = {
    "login": "https://creator.xiaohongshu.com/login",
    # 视频笔记发布页
    "publish_video": "https://creator.xiaohongshu.com/publish/publish?from=homepage&target=video",
    # 图文笔记发布页
    "publish_note": "https://creator.xiaohongshu.com/publish/publish?from=homepage&target=image",
    # 发布成功跳转 glob
    "success_glob": "**/publish/success?**",
    "success_url": "https://creator.xiaohongshu.com/publish/success?",
}


# ── 登录(扫码) ──────────────────────────────────────────────────────────
LOGIN = {
    # 登录框容器
    "login_box": "div[class*='login-box']",
    # 切到"扫一扫"的切换图标
    "switch_img": "img.css-wemwzq",
    # "扫一扫" tab 文字
    "scan_text": "div:has-text('扫一扫')",
    # 扫一扫区域容器(抓二维码用)
    "login_box_container": ".login-box-container",
    "scan_anchor_text": "APP扫一扫登录",
    # 二维码 img(锚文字后续 div 里的 img)
    "qrcode_img_xpath": "xpath=..//following-sibling::div//img",
}


# ── 上传(视频/图片) ─────────────────────────────────────────────────────
UPLOAD = {
    # 视频文件 input
    "video_input": "div[class^='upload-content'] input[class='upload-input']",
    # 图片文件 input(图文笔记)
    "image_input": 'input[type="file"][accept*="image"]',
    "image_input_fallback": "div[class^='upload-content'] input[class='upload-input']",
    # 上传后预览区(判断上传完成)
    "preview_input": "input.upload-input",
    "preview_new_xpath": 'xpath=following-sibling::div[contains(@class, "preview-new")]',
    "stage_div": "div.stage",
    # 上传完成关键字(预览区出现任一即视为成功)
    "done_keywords": ["上传成功", "分辨率", "重新上传", "编辑封面", "已上传", "已选择", "100%"],
    # 上传失败重传 input
    "reupload_input": 'div.progress-div [class^="upload-btn-input"]',
}


# ── 填写标题/正文/话题 ───────────────────────────────────────────────────
FILL = {
    # 标题输入框(也用作"进入编辑态"的判定标志)
    "title_input": 'input[placeholder*="填写标题"]',
    "title_max": 20,
    # 正文编辑器(contenteditable p)
    "desc_editor": 'p[data-placeholder*="输入正文描述"]',
    # 话题候选下拉容器
    "topic_container": "#creator-editor-topic-container",
    "topic_first_item": "#creator-editor-topic-container .item",
    # 小红书话题上限 10 个,超过会卡死发布
    "tags_max": 10,
}


# ── 封面(仅视频笔记) ───────────────────────────────────────────────────
COVER = {
    "cover_plugin_title_text": "设置封面",
    "cover_default_visible": "div.cover > div.default:visible",
    "cover_modal": "div.d-modal.cover-modal",
    "cover_file_input": 'input[type="file"][accept*="image"]',
    "cover_confirm_btn": "button.mojito-button",
    "cover_confirm_text": "确定",
}


# ── 原创声明(若有) ─────────────────────────────────────────────────────
DECLARATION = {
    "checkbox": (
        'div.original-declaration checkbox, '
        'div.original-declaration input[type="checkbox"], '
        'label:has-text("原创") input[type="checkbox"]'
    ),
    "text": (
        'div:has-text("原创声明"), span:has-text("原创声明"), '
        'div:has-text("原创"), label:has-text("原创")'
    ),
}


# ── 定时发布 ─────────────────────────────────────────────────────────────
SCHEDULE = {
    "switch": ".custom-switch-card",
    "switch_text": "定时发布",
    "switch_toggle": ".d-switch",
    "time_input": ".d-datepicker-input-filter input.d-text",
    "datetime_format": "%Y-%m-%d %H:%M",
}


# ── 发布按钮 ─────────────────────────────────────────────────────────────
PUBLISH = {
    "publish_btn": 'button:has-text("发布")',
    "schedule_publish_btn": 'button:has-text("定时发布")',
}
