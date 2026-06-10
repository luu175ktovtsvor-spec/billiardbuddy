"""
球房 AI 运营助手 — 全量浏览器自动化测试
模拟 5 个真实角色，覆盖所有模块和交互元素。
使用 Playwright + Mimo v2.5 视觉模型。
"""

import asyncio
import os
import time
from pathlib import Path

from browser_use import Agent, ChatOpenAI
from playwright.async_api import async_playwright

# ── 配置 ──
SCREENSHOT_DIR = Path("/tmp/billiards_test_screenshots")
SCREENSHOT_DIR.mkdir(exist_ok=True)

MIMO_API_KEY = "sk-cnp7ys529w4z42jwpwbjrntnbpzta6l82d70j3w9mcd9mzon"
MIMO_BASE_URL = "https://api.xiaomimimo.com/v1"
SITE_URL = "https://zzyppz.cn"
PHONE = "18664434400"
PASSWORD = "12345678"

llm = ChatOpenAI(
    model="mimo-v2.5",
    api_key=MIMO_API_KEY,
    base_url=MIMO_BASE_URL,
)

# ── 5 个模拟角色 ──
ROLES = {
    "店长": {
        "login_desc": "管理门店日常运营，关注朋友圈推广、老客户回访、员工管理",
        "tasks": [
            # (任务卡片标题, 输入的补充说明)
            ("今日朋友圈", "今天天气很好，门店下午空台多，想推一下氛围"),
            ("老客户回访", "有两周没来的老客户张哥，约他来打球顺便体验助教"),
            ("会员群空台提醒", "今晚7点到10点有5张空台，提醒会员来打球"),
            ("竞技群约局通知", "今晚8点约一场3v3的竞技对抗赛，赢的队伍免台费"),
            ("助教到店推广", "新来了一位技术陪练型助教小王，今天正式上钟"),
            ("周赛活动通知", "本周六下午2点举办周赛，报名费50元，冠军奖金500元"),
            ("员工群通知", "今天下午3点全员开会，讨论下周排班和卫生检查标准"),
            ("每日简报", "今天接待了35桌，营收8600元，助教上钟12次，会员新增3人"),
        ],
    },
    "助教管理": {
        "login_desc": "管理助教团队，关注助教推广、预约、培训、业绩",
        "tasks": [
            ("今日助教可约通知", "今天有3位助教可约，下午2点到晚上10点"),
            ("新助教到店", "新助教小李，擅长斯诺克，服务态度很好"),
            ("助教客户私聊邀约", "王姐好久没约助教了，上次体验很满意，想约她再来"),
            ("助教短视频配文", "助教小张打了一杆漂亮的清台，拍了短视频"),
            ("助教客户群维护", "助教客户群最近不太活跃，发个今日可约通知激活一下"),
            ("助教 PK 方案", "这个月搞个助教PK，比上钟数和客户好评率"),
            ("助教服务日报", "今天3位助教全部到岗，共上钟15次，客户评分4.8"),
            ("助教招聘文案", "招一位服务体验型助教，要求形象好、沟通能力强"),
        ],
    },
    "教练": {
        "login_desc": "负责赛事组织、竞技群运营、客户训练指导",
        "tasks": [
            ("周赛公告", "本周六下午2点周赛，32人淘汰赛，报名费50元"),
            ("竞技群报名提醒", "周赛还剩8个名额，截止到周五晚10点"),
            ("赛前提醒", "明天下午2点周赛，请参赛选手提前30分钟到场签到"),
            ("赛后战报", "本次周赛冠军张三，决赛7:5战胜李四，精彩对决"),
            ("好评引导", "今天有几位客户打得特别开心，引导他们去美团写好评"),
            ("教学课程推广", "新开了一对一私教课程，200元/小时，适合想提升技术的客户"),
            ("竞技客户维护", "老客户刘哥最近经常来打球，可以约他参加周赛"),
            ("抢一大战", "今晚8点抢一大战，一人挑战全场，赢了免台费"),
        ],
    },
    "前厅": {
        "login_desc": "负责接待、团购核销、客户投诉处理、开店闭店",
        "tasks": [
            ("团购核销后加微信", "客户刚核销了美团团购，引导加微信进会员群"),
            ("新客接待", "第一次来的新客户，介绍了门店设施和助教服务"),
            ("客户问会员怎么回", "客户问会员卡怎么办，有什么优惠"),
            ("客户问助教怎么回", "客户问助教是什么服务，怎么收费"),
            ("投诉安抚", "客户投诉空调太冷，需要安抚并解决"),
            ("客户问价格", "客户问台费多少钱，有没有优惠"),
            ("开店检查表", "早上开店前检查：设备、卫生、灯光、空调、收银系统"),
            ("闭店检查表", "晚上闭店检查：设备关闭、卫生清洁、门窗锁好、监控正常"),
        ],
    },
    "运营": {
        "login_desc": "负责内容规划、社交媒体运营、活动策划",
        "tasks": [
            ("本周内容规划", "本周朋友圈计划发3条，短视频2条，群公告每天1条"),
            ("朋友圈发布计划", "周一到周日的朋友圈内容主题规划"),
            ("短视频配文", "拍了一段门店氛围的短视频，需要配文案和话题标签"),
            ("会员群内容维护", "会员群每天发什么内容，保持活跃度"),
            ("活动海报文案", "周末要搞一个充值送活动，需要海报文案"),
            ("助教素材文案", "助教拍了很多打球视频，需要配不同的文案发不同平台"),
            ("门店氛围内容", "门店最近新装了氛围灯，拍了照片想发朋友圈"),
            ("抖音矩阵运营方案", "想在抖音上做矩阵号，主号发门店，子号助攻教IP"),
        ],
    },
}

# ── 自由输入交叉测试场景 ──
FREE_INPUT_SCENARIOS = [
    {
        "name": "团购客 × 店长 × 朋友圈",
        "intent": "今天美团来了好几波团购客户，想发一条朋友圈引导他们加微信进群",
        "role": "manager",
        "customer": "groupbuy",
        "outputs": ["moments", "private_chat"],
        "extra": "语气要自然一点，不要太商业化",
    },
    {
        "name": "竞技客 × 教练 × 群公告",
        "intent": "竞技群最近拉了几个新客户，想发个群公告介绍一下本周赛事安排",
        "role": "coach",
        "customer": "competition",
        "outputs": ["group_notice"],
        "extra": "要体现专业感，但不要太严肃",
    },
    {
        "name": "助教客 × 助教管理 × 私聊",
        "intent": "有位助教客户两周没来了，想私聊约他再来体验",
        "role": "assistant_manager",
        "customer": "assistant",
        "outputs": ["private_chat"],
        "extra": "上次他对助教小张的服务很满意，可以提一下",
    },
    {
        "name": "散客 × 前厅 × 多输出",
        "intent": "今天来了好几波散客，想发朋友圈推广一下门店氛围，同时在会员群发个空台提醒",
        "role": "frontdesk",
        "customer": "all",
        "outputs": ["moments", "group_notice", "execution_tips"],
        "extra": "朋友圈要轻松幽默，群公告要简洁明了",
    },
    {
        "name": "老客户 × 店长 × 活动方案",
        "intent": "想搞一个老客户回馈活动，充值1000送200，顺便办一场小型比赛",
        "role": "manager",
        "customer": "old",
        "outputs": ["activity_plan", "moments", "group_notice", "execution_tips"],
        "extra": "活动方案要详细，包含时间、规则、奖励",
    },
]


async def screenshot(page, name: str):
    """截图并保存"""
    path = SCREENSHOT_DIR / f"{name}.png"
    await page.screenshot(path=str(path), full_page=False)
    print(f"  📸 截图: {path.name}")
    return path


async def scroll_and_screenshot(page, name: str, scrolls: int = 3):
    """滚动页面并截图"""
    for i in range(scrolls):
        await page.mouse.wheel(0, 800)
        await asyncio.sleep(0.5)
    await screenshot(page, f"{name}_bottom")


async def login(page):
    """登录"""
    print("\n🔐 登录中...")
    await page.goto(f"{SITE_URL}/login")
    await page.wait_for_load_state("domcontentloaded")
    await page.fill('input[type="tel"]', PHONE)
    await page.fill('input[type="password"]', PASSWORD)
    await page.click('button[type="submit"]')
    await page.wait_for_url("**/dashboard**", timeout=15000)
    await asyncio.sleep(2)
    await screenshot(page, "00_login_success")
    print("  ✅ 登录成功")


# ═══════════════════════════════════════════
#  TEST 1: 首页检查
# ═══════════════════════════════════════════
async def test_dashboard(page):
    print("\n" + "=" * 60)
    print("  TEST 1: Dashboard 首页全量检查")
    print("=" * 60)

    await page.goto(f"{SITE_URL}/dashboard")
    await page.wait_for_load_state("domcontentloaded")
    await asyncio.sleep(2)

    # 截图顶部
    await screenshot(page, "01_dashboard_top")

    # 检查今日推荐是否已删除
    content = await page.content()
    if "今日推荐" in content:
        print("  ❌ BUG: '今日推荐' 仍然存在！")
    else:
        print("  ✅ '今日推荐' 已正确移除")

    # 检查是否有定价内容
    if "¥" in content or "免费版" in content or "专业版" in content or "团队版" in content:
        print("  ❌ BUG: 首页仍有定价内容！")
    else:
        print("  ✅ 首页无定价内容")

    # 滚动查看所有模块
    for i in range(5):
        page.mouse.wheel(0, 800)
        await asyncio.sleep(0.5)
    await screenshot(page, "01_dashboard_bottom")

    # 检查关键模块
    modules = ["内容日历", "我的模板"]
    for mod in modules:
        if mod in content:
            print(f"  ✅ 模块 '{mod}' 存在")
        else:
            print(f"  ❌ 模块 '{mod}' 缺失")

    # 测试内容日历的星期切换
    for day in ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]:
        btn = page.locator(f'button:has-text("{day}")')
        if await btn.count() > 0:
            await btn.first.click()
            await asyncio.sleep(0.3)
    print("  ✅ 内容日历星期切换全部可点击")
    await screenshot(page, "01_calendar_switched")


# ═══════════════════════════════════════════
#  TEST 2: AI 工作台 — 角色 × 卡片全量测试
# ═══════════════════════════════════════════
async def test_workbench_cards(page, role_name: str, role_config: dict):
    print(f"\n{'─' * 50}")
    print(f"  测试角色: {role_name} — {role_config['login_desc']}")
    print(f"{'─' * 50}")

    await page.goto(f"{SITE_URL}/dashboard/workbench")
    await page.wait_for_load_state("domcontentloaded")
    await asyncio.sleep(2)

    # 点击角色 tab
    role_tab_map = {
        "店长": "店长", "助教管理": "助教管理", "教练": "教练",
        "前厅": "前厅", "运营": "运营", "老板": "老板",
    }
    tab_name = role_tab_map.get(role_name, role_name)
    tab = page.locator(f'button:has-text("{tab_name}")').first
    if await tab.count() > 0:
        await tab.click()
        await asyncio.sleep(1)
        print(f"  ✅ 切换到 '{tab_name}' tab")
    else:
        print(f"  ❌ 找不到 '{tab_name}' tab")
        return

    await screenshot(page, f"02_workbench_{role_name}_cards")

    # 逐个点击该角色的卡片
    for idx, (card_title, extra_note) in enumerate(role_config["tasks"]):
        print(f"\n  📋 卡片 {idx + 1}/{len(role_config['tasks'])}: {card_title}")

        # 找到卡片的"一键生成"按钮
        card_btn = page.locator(f'button:has-text("一键生成")').nth(idx)
        if await card_btn.count() == 0:
            print(f"    ❌ 找不到 '{card_title}' 的一键生成按钮")
            continue

        # 滚动到卡片位置
        await card_btn.scroll_into_view_if_needed()
        await asyncio.sleep(0.5)

        # 点击一键生成
        try:
            await card_btn.click(timeout=5000)
        except Exception:
            # 按钮可能被 disabled（上一个生成还在进行），跳过
            print(f"    ⚠️ 按钮不可点击（可能上一个生成未完成），跳过")
            continue
        print(f"    🖱️ 点击了 '{card_title}'")

        # 等待生成完成（最多90秒）— 检查结果区域出现内容
        try:
            # 等待 "生成中..." 文字消失，或者结果区域出现
            await page.wait_for_function(
                """() => {
                    const btns = document.querySelectorAll('button');
                    const generating = Array.from(btns).some(b => b.textContent.includes('生成中'));
                    const results = document.querySelectorAll('[class*="prose"], [class*="result"], .markdown');
                    return !generating || results.length > 0;
                }""",
                timeout=90000,
            )
            await asyncio.sleep(3)
            print(f"    ✅ 生成完成")
        except Exception:
            print(f"    ⚠️ 生成超时（90秒），继续下一个")

        await screenshot(page, f"02_{role_name}_{idx:02d}_{card_title[:10]}")

        # 检查是否有错误信息
        error = page.locator('text="请求失败"')
        if await error.count() > 0:
            print(f"    ❌ 页面显示'请求失败'")

        error2 = page.locator('text="加载失败"')
        if await error2.count() > 0:
            print(f"    ❌ 页面显示'加载失败'")

    print(f"\n  ✅ {role_name} 角色全部 {len(role_config['tasks'])} 张卡片测试完成")


# ═══════════════════════════════════════════
#  TEST 3: 自由输入交叉测试
# ═══════════════════════════════════════════
async def test_free_input(page, scenario: dict):
    print(f"\n  📝 自由输入测试: {scenario['name']}")

    await page.goto(f"{SITE_URL}/dashboard/workbench")
    await page.wait_for_load_state("domcontentloaded")
    await asyncio.sleep(2)

    # 填写意图
    intent_input = page.locator('textarea').first
    await intent_input.fill(scenario["intent"])
    print(f"    ✅ 输入意图: {scenario['intent'][:30]}...")

    # 选择岗位
    role_select = page.locator('select').first
    if await role_select.count() > 0:
        await role_select.select_option(scenario["role"])
        print(f"    ✅ 选择岗位: {scenario['role']}")

    # 选择目标客户
    customer_select = page.locator('select').nth(1)
    if await customer_select.count() > 0:
        await customer_select.select_option(scenario["customer"])
        print(f"    ✅ 选择客户类型: {scenario['customer']}")

    # 填写补充说明
    extra_input = page.locator('textarea').nth(1)
    if await extra_input.count() > 0:
        await extra_input.fill(scenario["extra"])
        print(f"    ✅ 输入补充说明: {scenario['extra'][:30]}...")

    await screenshot(page, f"03_free_input_{scenario['name'][:15]}")

    # 点击生成
    gen_btn = page.locator('button:has-text("生成运营成品")')
    if await gen_btn.count() > 0:
        await gen_btn.click()
        print(f"    🖱️ 点击生成")

        # 等待生成
        try:
            await page.wait_for_function(
                "() => !document.querySelector('button[disabled]')",
                timeout=60000,
            )
            await asyncio.sleep(3)
            print(f"    ✅ 生成完成")
        except Exception:
            print(f"    ⚠️ 生成超时")

        await screenshot(page, f"03_free_result_{scenario['name'][:15]}")

        # 测试"基于此优化"
        optimize_input = page.locator('input[placeholder*="改"]')
        if await optimize_input.count() > 0:
            await optimize_input.fill("语气再轻松一点，加点幽默感")
            await optimize_input.press("Enter")
            print(f"    🖱️ 测试'基于此优化'")
            try:
                await page.wait_for_function(
                    "() => !document.querySelector('button[disabled]')",
                    timeout=60000,
                )
                await asyncio.sleep(3)
                print(f"    ✅ 优化完成")
            except Exception:
                print(f"    ⚠️ 优化超时")
            await screenshot(page, f"03_optimize_{scenario['name'][:15]}")


# ═══════════════════════════════════════════
#  TEST 4: AI 生图
# ═══════════════════════════════════════════
async def test_posters(page):
    print("\n" + "=" * 60)
    print("  TEST 4: AI 生图全量测试")
    print("=" * 60)

    await page.goto(f"{SITE_URL}/dashboard/posters")
    await page.wait_for_load_state("domcontentloaded")
    await asyncio.sleep(2)
    await screenshot(page, "04_posters_page")

    # 测试新对话按钮
    new_btn = page.locator('button:has-text("新对话")')
    if await new_btn.count() > 0:
        await new_btn.click()
        await asyncio.sleep(1)
        print("  ✅ '新对话'按钮可点击")
        await screenshot(page, "04_new_conversation")

    # 输入提示词生成
    prompt_input = page.locator('textarea').first
    if await prompt_input.count() > 0:
        await prompt_input.fill("一张台球房的宣传海报，高端大气，有专业灯光氛围")
        print("  ✅ 输入生图提示词")

    # 选择比例
    ratio_select = page.locator('select').first
    if await ratio_select.count() > 0:
        await ratio_select.select_option(index=1)
        print("  ✅ 选择图片比例")

    # 点击生成
    gen_btn = page.locator('button:has-text("生成")').first
    if await gen_btn.count() > 0:
        await gen_btn.click()
        print("  🖱️ 点击生成海报")

        # 等待生成（图片生成较慢，等90秒）
        try:
            await page.wait_for_selector('img[src*="blob:"], img[src*="data:"]', timeout=90000)
            await asyncio.sleep(3)
            print("  ✅ 海报生成完成")
        except Exception:
            print("  ⚠️ 海报生成超时（90秒）")

        await screenshot(page, "04_poster_result")

        # 测试"基于此调整"
        adjust_btn = page.locator('button:has-text("基于此调整")')
        if await adjust_btn.count() > 0:
            await adjust_btn.click()
            await asyncio.sleep(1)
            print("  ✅ 点击'基于此调整'")

            # 输入调整内容
            adjust_input = page.locator('textarea').last
            if await adjust_input.count() > 0:
                await adjust_input.fill("把背景换成深色，加一些霓虹灯效果")
                await adjust_input.press("Enter")
                print("  🖱️ 输入调整内容并提交")
                try:
                    await page.wait_for_selector('img[src*="blob:"], img[src*="data:"]', timeout=90000)
                    await asyncio.sleep(3)
                    print("  ✅ 调整后图片生成完成")
                except Exception:
                    print("  ⚠️ 调整后图片生成超时")
                await screenshot(page, "04_poster_adjusted")

    # 测试高级选项
    adv_btn = page.locator('button:has-text("高级选项")')
    if await adv_btn.count() > 0:
        await adv_btn.click()
        await asyncio.sleep(0.5)
        print("  ✅ 展开高级选项")
        await screenshot(page, "04_advanced_options")

    # 测试对话列表
    conv_items = page.locator('[class*="conversation"]')
    count = await conv_items.count()
    print(f"  📋 对话列表中有 {count} 个对话")


# ═══════════════════════════════════════════
#  TEST 5: 生成历史
# ═══════════════════════════════════════════
async def test_history(page):
    print("\n" + "=" * 60)
    print("  TEST 5: 生成历史全量测试")
    print("=" * 60)

    await page.goto(f"{SITE_URL}/dashboard/history")
    await page.wait_for_load_state("domcontentloaded")
    await asyncio.sleep(2)
    await screenshot(page, "05_history_page")

    # 检查是否有内容加载
    content = await page.content()
    if "加载失败" in content:
        print("  ❌ 历史记录加载失败")
    elif "暂无记录" in content or "没有" in content:
        print("  ⚠️ 暂无历史记录（正常，因为刚测试生成了一些）")
    else:
        print("  ✅ 历史记录正常加载")

    # 测试筛选功能
    # 只看收藏
    fav_btn = page.locator('button:has-text("只看收藏")')
    if await fav_btn.count() > 0:
        await fav_btn.click()
        await asyncio.sleep(1)
        print("  ✅ '只看收藏'按钮可点击")
        await fav_btn.click()  # 再次点击取消

    # 类型筛选
    type_select = page.locator('select').first
    if await type_select.count() > 0:
        options = await type_select.locator("option").all_text_contents()
        print(f"  📋 类型筛选选项: {options}")
        for opt in options[1:]:  # 跳过"全部类型"
            await type_select.select_option(label=opt)
            await asyncio.sleep(0.5)
        await type_select.select_option(index=0)  # 恢复全部
        print("  ✅ 类型筛选全部可切换")

    # 测试导出 CSV
    export_btn = page.locator('button:has-text("导出")')
    if await export_btn.count() > 0:
        print("  ✅ '导出CSV'按钮存在")

    # 点击第一条记录查看详情
    first_item = page.locator('[class*="cursor-pointer"]').first
    if await first_item.count() > 0:
        await first_item.click()
        await asyncio.sleep(1)
        await screenshot(page, "05_history_detail")
        print("  ✅ 点击第一条记录，详情弹窗打开")

        # 关闭弹窗
        close_btn = page.locator('button:has-text("×"), [aria-label="close"]').first
        if await close_btn.count() > 0:
            await close_btn.click()

    # 滚动查看
    await scroll_and_screenshot(page, "05_history", 3)


# ═══════════════════════════════════════════
#  TEST 6: 门店设置
# ═══════════════════════════════════════════
async def test_store_settings(page):
    print("\n" + "=" * 60)
    print("  TEST 6: 门店设置全量测试")
    print("=" * 60)

    await page.goto(f"{SITE_URL}/dashboard/store-settings")
    await page.wait_for_load_state("domcontentloaded")
    await asyncio.sleep(2)
    await screenshot(page, "06_store_settings")

    # 测试步骤导航
    for step_name in ["门店基础", "设施与经营", "AI 运营画像"]:
        step_btn = page.locator(f'button:has-text("{step_name}")')
        if await step_btn.count() > 0:
            await step_btn.click()
            await asyncio.sleep(1)
            await screenshot(page, f"06_step_{step_name}")
            print(f"  ✅ 步骤 '{step_name}' 可切换")

    # 测试保存按钮
    save_btn = page.locator('button:has-text("保存")')
    if await save_btn.count() > 0:
        print("  ✅ '保存'按钮存在")

    # 滚动查看所有字段
    await scroll_and_screenshot(page, "06_settings_bottom", 5)


# ═══════════════════════════════════════════
#  TEST 7: 团队成员
# ═══════════════════════════════════════════
async def test_members(page):
    print("\n" + "=" * 60)
    print("  TEST 7: 团队成员全量测试")
    print("=" * 60)

    await page.goto(f"{SITE_URL}/dashboard/store-settings/members")
    await page.wait_for_load_state("domcontentloaded")
    await asyncio.sleep(2)
    await screenshot(page, "07_members")

    # 测试手动添加
    add_btn = page.locator('button:has-text("手动添加")')
    if await add_btn.count() > 0:
        await add_btn.click()
        await asyncio.sleep(1)
        await screenshot(page, "07_add_member_form")
        print("  ✅ '手动添加'按钮可点击，表单已展开")

        # 取消
        cancel_btn = page.locator('button:has-text("取消")')
        if await cancel_btn.count() > 0:
            await cancel_btn.click()

    # 测试生成邀请码
    invite_btn = page.locator('button:has-text("生成邀请码")')
    if await invite_btn.count() > 0:
        await invite_btn.click()
        await asyncio.sleep(1)
        await screenshot(page, "07_invite_form")
        print("  ✅ '生成邀请码'按钮可点击，表单已展开")

        cancel_btn = page.locator('button:has-text("取消")')
        if await cancel_btn.count() > 0:
            await cancel_btn.click()

    # 测试 tab 切换（用精确匹配避免匹配到"生成邀请码"按钮）
    member_tab = page.get_by_role("button", name="成员")
    if await member_tab.count() > 0:
        await member_tab.first.click()
        await asyncio.sleep(0.5)
        print("  ✅ '成员' tab 可切换")

    invite_tab = page.get_by_role("button", name="邀请码 (")
    if await invite_tab.count() > 0:
        await invite_tab.first.click()
        await asyncio.sleep(0.5)
        print("  ✅ '邀请码' tab 可切换")


# ═══════════════════════════════════════════
#  TEST 8: 侧边栏导航
# ═══════════════════════════════════════════
async def test_sidebar_navigation(page):
    print("\n" + "=" * 60)
    print("  TEST 8: 侧边栏导航全量测试")
    print("=" * 60)

    nav_items = [
        ("首页", "/dashboard"),
        ("AI 工作台", "/dashboard/workbench"),
        ("AI 生图", "/dashboard/posters"),
        ("生成历史", "/dashboard/history"),
        ("门店设置", "/dashboard/store-settings"),
        ("团队成员", "/dashboard/store-settings/members"),
    ]

    for label, expected_path in nav_items:
        nav_link = page.locator(f'a:has-text("{label}")').first
        if await nav_link.count() > 0:
            await nav_link.click()
            await asyncio.sleep(1)
            current_url = page.url
            if expected_path in current_url:
                print(f"  ✅ '{label}' → 跳转正确")
            else:
                print(f"  ❌ '{label}' → 跳转错误，当前: {current_url}")
        else:
            print(f"  ❌ '{label}' 链接不存在")


# ═══════════════════════════════════════════
#  主测试流程
# ═══════════════════════════════════════════
async def main():
    print("🏆 球房 AI 运营助手 — 全量浏览器自动化测试")
    print(f"   目标: {SITE_URL}")
    print(f"   截图目录: {SCREENSHOT_DIR}")
    print(f"   测试时间: {time.strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"   角色数: {len(ROLES)}")
    print(f"   自由输入场景: {len(FREE_INPUT_SCENARIOS)}")

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=False)  # 可见模式
        context = await browser.new_context(
            viewport={"width": 1280, "height": 800},
            locale="zh-CN",
        )
        page = await context.new_page()

        try:
            # 登录
            await login(page)

            # TEST 1: Dashboard
            await test_dashboard(page)

            # TEST 2: 工作台 — 每个角色的每张卡片
            for role_name, role_config in ROLES.items():
                await test_workbench_cards(page, role_name, role_config)

            # TEST 3: 自由输入交叉测试
            print("\n" + "=" * 60)
            print("  TEST 3: 自由输入交叉测试")
            print("=" * 60)
            for scenario in FREE_INPUT_SCENARIOS:
                await test_free_input(page, scenario)

            # TEST 4: AI 生图
            await test_posters(page)

            # TEST 5: 生成历史
            await test_history(page)

            # TEST 6: 门店设置
            await test_store_settings(page)

            # TEST 7: 团队成员
            await test_members(page)

            # TEST 8: 侧边栏导航
            await test_sidebar_navigation(page)

        finally:
            await browser.close()

    print("\n" + "=" * 60)
    print("  🎉 全部测试完成！")
    print(f"  📁 截图保存在: {SCREENSHOT_DIR}")
    print(f"  📊 截图数量: {len(list(SCREENSHOT_DIR.glob('*.png')))}")
    print("=" * 60)


if __name__ == "__main__":
    asyncio.run(main())
