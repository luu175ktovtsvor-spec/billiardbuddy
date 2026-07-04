"""台球场景方案（开业 / 会员卡 / 比赛）成品交付物包。

数据流：老板需求(文字) → LLM 结合行业底料生成结构化 JSON(见 manifest.parse_plan_json)
       → 拼装 manifest(见 manifest.build_manifest) → 复用 V2 离屏渲染器出图片版/网页版(见 render.py)。

纯逻辑（manifest.py）与真渲染子进程（render.py）分开：前者无 I/O、单测直接跑；
后者调 `services.video_edit.template_render._render_html_frames`（Electron 离屏，见该模块），
单测须 monkeypatch 掉，不真拉 Electron。
"""
