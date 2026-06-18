# -*- coding: utf-8 -*-
"""抖音 creator.douyin.com 网页发布的【集中选择器表】(dy_selectors.py)。

⚠️ 文件名特意不叫 selectors.py:cli.py 以本目录为 cwd 运行,
   与标准库 selectors 撞名会让 asyncio 崩(asyncio 内部会 import selectors)。

⚠️ 平台改版只改这里,业务逻辑(douyin_uploader.py)不动。
来源:dreammis/social-auto-upload(12.7k★)的 uploader/douyin_uploader/main.py,
其中的选择器是该仓库在真实抖音创作者后台验证过的(2026 年现行版),本文件做了原样搬运 + 注释。
"""

# ── 入口 URL(login / upload / publish 三套 + 双版本兼容) ────────────────
URLS = {
    "home": "https://creator.douyin.com/",
    # 登录成功后会跳到 creator-micro/home
    "login_ok_prefix": "https://creator.douyin.com/creator-micro/home",
    # 上传页(投喂视频文件)
    "upload": "https://creator.douyin.com/creator-micro/content/upload",
    # 发布页有两套 URL(抖音灰度,做双兼容)
    "publish_v1": "https://creator.douyin.com/creator-micro/content/publish?enter_from=publish_page",
    "publish_v2": "https://creator.douyin.com/creator-micro/content/post/video?enter_from=publish_page",
    # 发布成功后跳作品管理页(glob 匹配)
    "manage_glob": "https://creator.douyin.com/creator-micro/content/manage**",
}


# ── 登录(扫码) ──────────────────────────────────────────────────────────
LOGIN = {
    # "扫码登录" tab(精确文字)
    "scan_tab_text": "扫码登录",
    # 二维码 img:tab 同级后一个 div 里、aria-label=二维码 的 img
    # 兜底用 role=img name=二维码
    "qrcode_img_aria": 'img[aria-label="二维码"]',
    "qrcode_img_role_name": "二维码",
    # 判断未登录的标志文字(出现说明还在登录页)
    "need_login_texts": ["手机号登录", "扫码登录"],
    # 二维码失效提示文字(点它可刷新)
    "qrcode_expired_text": "二维码失效",
}


# ── 上传(投喂视频文件) ──────────────────────────────────────────────────
UPLOAD = {
    # 视频文件 input:上传页 container 下的 input
    "video_file_input": "div[class^='container'] input",
    # 上传失败时的重传 input
    "reupload_input": 'div.progress-div [class^="upload-btn-input"]',
    # "重新上传" 出现 = 视频已传完
    "upload_done_marker": '[class^="long-card"] div:has-text("重新上传")',
    # 上传失败提示
    "upload_failed_marker": 'div.progress-div > div:has-text("上传失败")',
}


# ── 填写标题/描述/话题 ───────────────────────────────────────────────────
# 描述区:从 "作品描述" 文字往上 2 层、再取后一个兄弟 div
FILL = {
    "desc_anchor_text": "作品描述",
    # 在 desc_section 内定位标题输入框(第一个 text input)
    "title_input_in_section": 'input[type="text"]',
    # 描述编辑器(contenteditable 的 zone-container)
    "desc_editor_in_section": '.zone-container[contenteditable="true"]',
}


# ── 封面 ─────────────────────────────────────────────────────────────────
COVER = {
    "choose_cover_text": "选择封面",
    "cover_modal": 'div[id*="creator-content-modal"]',
    # 封面弹窗里的隐藏上传 input
    "cover_upload_input": "div[class^='semi-upload upload'] >> input.semi-upload-hidden-input",
    # 竖版封面步骤切换
    "cover_portrait_step": "div[class*='steps'] div",
    "cover_finish_btn": 'button:visible:has-text("完成")',
    "cover_modal_footer_gone": "div.extractFooter",
    # 发布前若提示"请设置封面后再发布",自动选第一个推荐封面
    "need_cover_text": "请设置封面后再发布",
    "recommend_cover": '[class^="recommendCover-"]',
    "cover_confirm_text": "是否确认应用此封面？",
}


# ── 定时发布 ─────────────────────────────────────────────────────────────
SCHEDULE = {
    "radio_scheduled": "[class^='radio']:has-text('定时发布')",
    "datetime_input": '.semi-input[placeholder="日期和时间"]',
    "datetime_format": "%Y-%m-%d %H:%M",
}


# ── 自主声明(抖音发布常为必选) ─────────────────────────────────────────
DECLARATION = {
    "entry_text": "请选择自主声明",
    "dialog": ".semi-modal-content",
    "dialog_title": "对作品内容添加声明",
    "radio": ".semi-radio",
    "default_declaration": "内容为个人观点或见解",
}


# ── 发布按钮 / 同步到其他平台开关 ────────────────────────────────────────
PUBLISH = {
    # 发布按钮(精确名"发布")
    "publish_btn_name": "发布",
    # "同步到今日头条/西瓜"之类的第三方开关(默认关掉,不勾)
    "third_part_switch": '[class^="info"] > [class^="first-part"] div div.semi-switch',
    "third_part_switch_checked_cls": "semi-switch-checked",
    "third_part_native_input": "input.semi-switch-native-control",
    "confirm_btn_name": "确定",
}
