# -*- coding: utf-8 -*-
"""快手创作者平台(cp.kuaishou.com)网页发布的【集中选择器表】(ks_selectors.py)。

⚠️ 文件名特意不叫 selectors.py:cli.py 以本目录为 cwd 运行,
   与标准库 selectors 撞名会让 asyncio 崩(asyncio 内部会 import selectors)。

⚠️ 平台改版只改这里,业务逻辑(kuaishou_uploader.py)不动。
来源:dreammis/social-auto-upload(12.7k★)的 uploader/ks_uploader/main.py,
其中的选择器是该仓库在真实快手创作者平台验证过的(2026 年现行版,已迁 patchright),
本文件做了原样搬运 + 注释。
"""

from __future__ import annotations

# ── 入口 URL(login / upload / manage 三套) ──────────────────────────────
URLS = {
    # 上传页(投喂视频文件 + 填描述 + 发布)
    "upload": "https://cp.kuaishou.com/article/publish/video",
    # 上传页 glob(wait_for_url 用,upload 页带各种 query)
    "upload_glob": "**/article/publish/video**",
    # 发布成功后跳作品管理页
    "manage_glob": "**/article/manage/video?status=2&from=publish**",
    # 登录页(passport 跳板,回调回 cp 上传页)
    "login": (
        "https://passport.kuaishou.com/pc/account/login/?sid=kuaishou.web.cp.api"
        "&callback=https%3A%2F%2Fcp.kuaishou.com%2Frest%2Finfra%2Fsts%3FfollowUrl%3D"
        "https%253A%252F%252Fcp.kuaishou.com%252Farticle%252Fpublish%252Fvideo"
        "%26setRootDomain%3Dtrue"
    ),
}


# ── 登录(扫码) ──────────────────────────────────────────────────────────
LOGIN = {
    # 登录表单容器
    "login_form": "main#login-form",
    # 二维码 img(扫码登录 tab 下)
    "qrcode_img": 'div.qr-login img[alt="qrcode"]',
    # "切换登录方式"按钮(默认可能停在账号密码,点它切到扫码)
    "platform_switch": "div.platform-switch",
    # 二维码失效遮罩
    "qrcode_expired": "div.qrcode-status.qrcode-status-timeout",
    # 二维码刷新按钮
    "qrcode_refresh": "p.qrcode-refresh",
    # cookie 失效标志:登录态下上传页才会出现"机构服务"导航
    "cookie_invalid_marker": "div.names div.container div.name:text('机构服务')",
}


# ── 上传(投喂视频文件) ──────────────────────────────────────────────────
UPLOAD = {
    # 上传按钮(点它弹文件选择器)
    "upload_btn": "button[class^='_upload-btn']",
    # 上传失败时的重传 input
    "reupload_input": 'div.progress-div [class^="upload-btn-input"]',
    # "上传中"文字(还在 = 没传完)
    "uploading_text": "text=上传中",
    # "上传失败"文字
    "upload_failed_text": "text=上传失败",
    # 上传后可能弹的引导提示"我知道了"
    "know_btn": 'button[type="button"] span:text("我知道了")',
    # react-joyride 新手引导遮罩
    "joyride_tooltip": 'div[id^="react-joyride-step"] div[role="alertdialog"]',
    "joyride_skip_btn": '[aria-label="Skip"], [data-action="skip"], button[title="Skip"]',
}


# ── 填写描述/话题 ────────────────────────────────────────────────────────
FILL = {
    # 描述区:从"描述"文字往后一个兄弟 div(可编辑区)
    "desc_anchor_text": "描述",
}


# ── 封面 ─────────────────────────────────────────────────────────────────
COVER = {
    # "封面设置"标签
    "cover_label_text": "封面设置",
    # 封面弹窗(ant-modal)
    "cover_modal": 'div[role="document"].ant-modal',
    # 弹窗内"上传封面"tab
    "upload_cover_tab_text": "上传封面",
    # 弹窗内文件 input
    "cover_file_input": 'input[type="file"]',
    # 弹窗内"确认"按钮
    "cover_confirm_btn_name": "确认",
}


# ── 定时发布 ─────────────────────────────────────────────────────────────
SCHEDULE = {
    # 定时发布 radio(ant-radio-wrapper,文本匹配)
    "radio_scheduled_text": "定时发布",
    # 时间选择 input
    "datetime_input": 'input[placeholder="选择日期时间"]',
    # ant DatePicker 是受控组件,必须用 native setter + bubbling event
    "datetime_format": "%Y-%m-%d %H:%M:%S",
}


# ── 发布按钮 ─────────────────────────────────────────────────────────────
PUBLISH = {
    # 发布按钮(精确名"发布")
    "publish_btn_text": "发布",
    # 二次确认"确认发布"
    "confirm_publish_text": "确认发布",
}
