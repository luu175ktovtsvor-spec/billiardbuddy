from models.store import Store

POSITIONING_LABELS = {
    "community_affordable": "社区球房",
    "commercial_premium": "商业球房",
    "competition_focused": "竞技球房",
    "competition_commercial": "竞技商业球房",
    "community": "社区球房",
    "commercial": "商业球房",
    "competitive": "竞技球房",
    "competitive_commercial": "竞技商业球房",
}

TONE_LABELS = {
    "casual_friendly": "熟人自然",
    "light_humorous": "轻松幽默",
    "premium_business": "高端商务",
    "young_trendy": "年轻潮流",
    "short_direct": "简短直接",
}

CUSTOMER_TYPE_LABELS = {
    "casual": "散客",
    "competitive": "竞技客户",
    "assistant": "助教客户",
    "point_chaser": "追分客户",
    "groupbuy": "团购客",
    "new": "新客户",
    "old": "老客户",
    "light_competition": "轻竞技客户",
    "vip": "VIP/大客户",
    "solo": "单人练球客户",
    "all": "全部客户",
}

GOAL_LABELS = {
    "customer_acquisition": "拉新",
    "old_customer_recall": "老客户回流",
    "groupbuy_conversion": "团购客转私域",
    "assistant_booking": "助教预约转化",
    "tournament_growth": "提升周赛人气",
    "content_output": "提高朋友圈发布频率",
    "frontdesk_conversion": "提升前厅转化",
    "assistant_attendance": "提升助教上钟",
    "matchmaking_active": "搭子群活跃",
}

ASSISTANT_TYPE_LABELS = {
    "service_experience": "服务体验型助教",
    "technical_coaching": "技术陪练型/高级助教",
}

OUTPUT_LENGTH_LABELS = {
    "short": "简短",
    "medium": "中等",
    "long": "详细",
}

TABLE_TYPE_LABELS = {
    "normal_pool_table": "普通台球桌",
    "duya_pool_table": "独牙台球桌",
    "joy_billiards_table": "乔氏台球桌",
    "snooker_table": "斯诺克",
}


def render_operation_profile_context(store: Store) -> str:
    profile = store.operation_profile
    if not profile or not isinstance(profile, dict):
        return ""

    parts: list[str] = []

    # ── 1. 基础画像 ──
    basic = profile.get("basic", {})
    if isinstance(basic, dict):
        basic_lines: list[str] = []
        positioning = basic.get("positioning", "")
        if positioning:
            label = POSITIONING_LABELS.get(positioning, positioning)
            basic_lines.append(f"门店定位：{label}")

        business_district = basic.get("business_district", "")
        if business_district:
            basic_lines.append(f"商圈/区域：{business_district}")

        table_count = basic.get("table_count")
        if table_count is not None:
            basic_lines.append(f"球桌数量：{table_count}张")

        selling_points = basic.get("main_selling_points", [])
        if isinstance(selling_points, list) and selling_points:
            basic_lines.append(f"主要卖点：{'、'.join(selling_points)}")

        # 来自 Store 列的补充信息
        if store.has_private_room:
            basic_lines.append("门店有包间/包厢")
        if store.coach_count is not None and store.coach_count > 0:
            basic_lines.append(f"助教人数：{store.coach_count}人")
        if store.common_activities:
            basic_lines.append(f"常见活动类型：{store.common_activities}")

        allow_address = basic.get("allow_address_in_content", False)
        allow_phone = basic.get("allow_phone_in_content", False)
        if not allow_address:
            basic_lines.append("内容中不要写门店详细地址")
        else:
            basic_lines.append("允许在内容中包含门店详细地址")
        if not allow_phone:
            basic_lines.append("内容中不要写门店联系电话")
        else:
            basic_lines.append("允许在内容中包含门店联系电话")

        if basic_lines:
            parts.append("【门店基础画像】\n" + "\n".join(f"- {line}" for line in basic_lines))

    # ── 1.5 设备桌型 ──
    equipment = profile.get("equipment", {})
    if isinstance(equipment, dict):
        equip_lines: list[str] = []
        table_types = equipment.get("table_types", [])
        if isinstance(table_types, list) and table_types:
            labels = [TABLE_TYPE_LABELS.get(t, t) for t in table_types]
            equip_lines.append(f"门店设备：{'、'.join(labels)}")

        table_type_note = equipment.get("table_type_note", "")
        if table_type_note:
            equip_lines.append(f"桌型补充：{table_type_note}")

        if equip_lines:
            equip_lines.append("未提供桌型时，不要编造门店桌型。未提供新设备/升级信息时，不要写新到台球桌、新换设备、升级乔氏台等表达。桌型未知时可使用店里台子、来打两把等通用表达。")
            parts.append("【门店设备】\n" + "\n".join(f"- {line}" for line in equip_lines))

    # ── 2. 经营目标 ──
    goals = profile.get("business_goals", {})
    if isinstance(goals, dict):
        goal_lines: list[str] = []
        current_goals = goals.get("current_goals", [])
        if isinstance(current_goals, list) and current_goals:
            labels = [GOAL_LABELS.get(g, g) for g in current_goals]
            goal_lines.append(f"当前最想提升：{'、'.join(labels)}")

        monthly_focus = goals.get("monthly_focus", "")
        if monthly_focus:
            goal_lines.append(f"本月重点：{monthly_focus}")

        avoid = goals.get("avoid_recommendations", [])
        if isinstance(avoid, list) and avoid:
            goal_lines.append(f"生成内容时请避免推荐：{'、'.join(avoid)}")

        if goal_lines:
            parts.append("【经营目标】\n" + "\n".join(f"- {line}" for line in goal_lines))

    # ── 3. 客户结构 ──
    customer = profile.get("customer_structure", {})
    if isinstance(customer, dict):
        cust_lines: list[str] = []
        main_types = customer.get("main_customer_types", [])
        if isinstance(main_types, list) and main_types:
            labels = [CUSTOMER_TYPE_LABELS.get(t, t) for t in main_types]
            cust_lines.append(f"主要客户类型：{'、'.join(labels)}")

        target_types = customer.get("target_conversion_types", [])
        if isinstance(target_types, list) and target_types:
            labels = [CUSTOMER_TYPE_LABELS.get(t, t) for t in target_types]
            cust_lines.append(f"重点转化客户：{'、'.join(labels)}")

        if cust_lines:
            parts.append("【客户结构】\n" + "\n".join(f"- {line}" for line in cust_lines))

    # ── 4. 私域群矩阵（必须包含会员群和竞技群） ──
    groups = profile.get("private_domain_groups", {})
    if isinstance(groups, dict):
        group_lines: list[str] = []
        enabled_groups = []

        group_configs = [
            ("customer_group", "客户群", "客户日常沟通、活动通知、朋友圈同步"),
            ("member_group", "会员群", "会员维护、空台提醒、活动通知、老客户复购提醒。生成会员群内容时，不得自动编造会员专属优惠、充值规则、会员权益或会员专属价格，除非用户明确提供"),
            ("competition_group", "竞技群", "约局、周赛/月赛通知、轻竞技活动、赛后战报、找搭子和练球局。生成竞技群内容时，不得写赌博、追分、大额输赢、搞钱局或高风险对局表达"),
            ("partner_group", "搭子群", "找人打球、拼局、新人融入、临时约球。表达要自然，不要写赌博或高风险对局"),
            ("assistant_customer_group", "助教客户群", "助教到店通知、助教可约提醒、助教服务推广和助教客户维护。不得写免费助教、送助教课或低俗擦边表达"),
            ("event_group", "赛事群", "赛事通知、报名、赛制说明、赛后战报"),
            ("staff_group", "员工群", "员工通知、生日祝福、SOP提醒、卫生检查和开闭店事项。不得擅自安排调休、奖金、处罚或顶班"),
        ]

        for group_key, group_name, group_desc in group_configs:
            g = groups.get(group_key, {})
            if isinstance(g, dict) and g.get("enabled"):
                enabled_groups.append(group_name)
                group_lines.append(f"- {group_name}：{group_desc}")

        if enabled_groups:
            parts.append(
                f"【私域群矩阵】门店有以下私域群：{'、'.join(enabled_groups)}\n"
                + "\n".join(group_lines)
            )

    # ── 5. 助教体系 ──
    assistant = profile.get("assistant_system", {})
    if isinstance(assistant, dict):
        ast_lines: list[str] = []
        has_assistant = assistant.get("has_assistant", False)
        if has_assistant:
            ast_lines.append("门店有助教服务")

            assistant_types = assistant.get("assistant_types", [])
            if isinstance(assistant_types, list) and assistant_types:
                labels = [ASSISTANT_TYPE_LABELS.get(t, t) for t in assistant_types]
                ast_lines.append(f"助教类型：{'、'.join(labels)}")

            if assistant.get("has_assistant_manager"):
                ast_lines.append("有专门的助教管理")

            if assistant.get("allow_new_assistant_notice"):
                ast_lines.append("允许生成新助教到店通知内容")
            else:
                ast_lines.append("不要自动生成新助教到店内容")

            if assistant.get("allow_today_assistant_available"):
                ast_lines.append("允许生成今日助教可约内容")
            else:
                ast_lines.append("不要生成今日助教可约内容")

            booking_rule = assistant.get("assistant_booking_rule", "")
            if booking_rule:
                ast_lines.append(f"助教预约方式：{booking_rule}")

            forbidden = assistant.get("assistant_forbidden_words", [])
            if isinstance(forbidden, list) and forbidden:
                ast_lines.append(f"助教内容禁用词：{'、'.join(forbidden)}")

        if ast_lines:
            parts.append("【助教体系】\n" + "\n".join(f"- {line}" for line in ast_lines))

    # ── 6. 赛事/活动 ──
    events = profile.get("events", {})
    if isinstance(events, dict):
        event_lines: list[str] = []
        if events.get("has_weekly_match"):
            event_lines.append("门店有固定周赛")
        if events.get("has_light_competition"):
            event_lines.append("门店有轻竞技/台费局活动")
        if events.get("has_partner_group"):
            event_lines.append("门店有搭子群活动")

        if event_lines:
            parts.append("【赛事活动】\n" + "\n".join(f"- {line}" for line in event_lines))

    # ── 7. 团购/价格规则 ──
    commerce = profile.get("commerce_rules", {})
    if isinstance(commerce, dict):
        commerce_lines: list[str] = []
        if commerce.get("has_groupbuy"):
            commerce_lines.append("门店做团购（美团/抖音等）")
        if commerce.get("has_membership"):
            commerce_lines.append("门店有会员体系")

        allow_discount = commerce.get("allow_discount_copy", False)
        allow_price = commerce.get("allow_price_copy", False)

        if allow_discount:
            commerce_lines.append("允许AI在内容中提及优惠信息（需用户提供具体方案）")
        else:
            commerce_lines.append("禁止AI自动编造优惠/折扣/充值赠送信息")

        if allow_price:
            commerce_lines.append("允许AI在内容中写价格")
        else:
            commerce_lines.append("禁止AI在内容中擅自写具体价格数字，不确定时用占位符")

        if commerce_lines:
            parts.append("【团购/价格规则】\n" + "\n".join(f"- {line}" for line in commerce_lines))

    # ── 7.5 会员体系（来自 Store 列） ──
    membership_lines: list[str] = []
    if store.membership_types:
        if isinstance(store.membership_types, list):
            membership_lines.append(f"会员卡类型：{'、'.join(str(m) for m in store.membership_types)}")
        elif isinstance(store.membership_types, dict):
            for k, v in store.membership_types.items():
                membership_lines.append(f"  {k}：{v}")
    if store.recharge_rules:
        if isinstance(store.recharge_rules, list):
            membership_lines.append(f"充值规则：{'、'.join(str(r) for r in store.recharge_rules)}")
        elif isinstance(store.recharge_rules, dict):
            for k, v in store.recharge_rules.items():
                membership_lines.append(f"  {k}：{v}")
    if store.membership_benefits:
        if isinstance(store.membership_benefits, list):
            membership_lines.append(f"会员权益：{'、'.join(str(b) for b in store.membership_benefits)}")
        elif isinstance(store.membership_benefits, dict):
            for k, v in store.membership_benefits.items():
                membership_lines.append(f"  {k}：{v}")
    if membership_lines:
        parts.append("【会员体系】\n" + "\n".join(f"- {line}" for line in membership_lines))

    # ── 8. 内容风格 ──
    style = profile.get("content_style", {})
    if isinstance(style, dict):
        style_lines: list[str] = []
        moments_tone = style.get("moments_tone", "")
        if moments_tone:
            label = TONE_LABELS.get(moments_tone, moments_tone)
            style_lines.append(f"朋友圈语气：{label}")

        private_tone = style.get("private_chat_tone", "")
        if private_tone:
            label = TONE_LABELS.get(private_tone, private_tone)
            style_lines.append(f"私聊语气：{label}")

        group_tone = style.get("group_notice_tone", "")
        if group_tone:
            label = TONE_LABELS.get(group_tone, group_tone)
            style_lines.append(f"群公告语气：{label}")

        emoji = style.get("emoji_preference", "")
        if emoji:
            style_lines.append(f"Emoji偏好：{emoji}")

        common_phrases = style.get("common_phrases", [])
        if isinstance(common_phrases, list) and common_phrases:
            style_lines.append(f"常用口头语：{'、'.join(common_phrases)}")

        forbidden_phrases = style.get("forbidden_phrases", [])
        if isinstance(forbidden_phrases, list) and forbidden_phrases:
            style_lines.append(f"禁用表达（门店自定）：{'、'.join(forbidden_phrases)}")

        if style_lines:
            parts.append("【内容风格偏好】\n" + "\n".join(f"- {line}" for line in style_lines))

    # ── 9. AI 偏好 ──
    ai_prefs = profile.get("ai_preferences", {})
    if isinstance(ai_prefs, dict):
        ai_lines: list[str] = []
        output_len = ai_prefs.get("default_output_length", "")
        if output_len:
            label = OUTPUT_LENGTH_LABELS.get(output_len, output_len)
            ai_lines.append(f"默认输出长度：{label}")

        strategy = ai_prefs.get("missing_info_strategy", "")
        if strategy == "safe_generate_with_missing_info":
            ai_lines.append("信息不足时：生成安全通用版内容，同时列出需要补充的信息")
        elif strategy == "list_missing":
            ai_lines.append("信息不足时：先列出需要补充的信息，不生成内容")
        elif strategy == "placeholder":
            ai_lines.append("信息不足时：使用占位符标记缺失信息")

        if ai_lines:
            parts.append("【AI生成偏好】\n" + "\n".join(f"- {line}" for line in ai_lines))

    if not parts:
        return ""

    return "\n\n".join(parts)


def calculate_operation_profile_completeness(profile: dict | None) -> dict:
    """计算门店运营画像完整度评分（0-100），含模块细分。"""
    if not profile or not isinstance(profile, dict):
        return {
            "overall_score": 0,
            "modules": {},
            "completed_modules": [],
            "suggested_modules": [
                "basic", "business_goals", "customer_structure",
                "private_domain_groups", "assistant_system", "events",
                "commerce_rules", "equipment", "content_style",
            ],
        }

    modules = {}

    def _bool_answered(data: dict, key: str) -> bool:
        return key in data and isinstance(data.get(key), bool)

    # basic: 门店定位、商圈/区域、主要卖点
    basic = profile.get("basic", {}) if isinstance(profile.get("basic"), dict) else {}
    b_fields = ["positioning", "business_district"]
    b_filled = sum(1 for f in b_fields if basic.get(f))
    b_selling = isinstance(basic.get("main_selling_points"), list) and basic.get("main_selling_points")
    if b_selling:
        b_filled += 1
    b_total = len(b_fields) + 1
    modules["basic"] = {
        "score": min(100, int(b_filled / b_total * 100)),
        "completed": b_filled >= len(b_fields),
        "missing_fields": [f for f in b_fields if not basic.get(f)] + ([] if b_selling else ["main_selling_points"]),
    }

    # business_goals: current_goals + monthly_focus + avoid_recommendations
    goals = profile.get("business_goals", {}) if isinstance(profile.get("business_goals"), dict) else {}
    g_filled = 1 if isinstance(goals.get("current_goals"), list) and goals.get("current_goals") else 0
    if goals.get("monthly_focus"):
        g_filled += 1
    g_total = 2
    modules["business_goals"] = {
        "score": min(100, int(g_filled / g_total * 100)),
        "completed": bool(isinstance(goals.get("current_goals"), list) and goals.get("current_goals")),
        "missing_fields": [] if (isinstance(goals.get("current_goals"), list) and goals.get("current_goals")) else ["current_goals"],
    }

    # customer_structure: main_customer_types + target_conversion_types
    cust = profile.get("customer_structure", {}) if isinstance(profile.get("customer_structure"), dict) else {}
    c_types = isinstance(cust.get("main_customer_types"), list) and cust.get("main_customer_types")
    c_target = isinstance(cust.get("target_conversion_types"), list) and cust.get("target_conversion_types")
    c_filled = (1 if c_types else 0) + (1 if c_target else 0)
    modules["customer_structure"] = {
        "score": min(100, int(c_filled / 2 * 100)),
        "completed": bool(c_types),
        "missing_fields": [] if c_types else ["main_customer_types"],
    }

    # private_domain_groups
    groups = profile.get("private_domain_groups", {}) if isinstance(profile.get("private_domain_groups"), dict) else {}
    enabled_count = sum(1 for k in groups if isinstance(groups.get(k), dict) and groups[k].get("enabled"))
    has_member = isinstance(groups.get("member_group"), dict) and groups["member_group"].get("enabled")
    has_competition = isinstance(groups.get("competition_group"), dict) and groups["competition_group"].get("enabled")
    pdg_score = min(100, enabled_count * 25)
    if has_member:
        pdg_score = min(100, pdg_score + 10)
    if has_competition:
        pdg_score = min(100, pdg_score + 10)
    modules["private_domain_groups"] = {
        "score": pdg_score,
        "completed": enabled_count >= 1,
        "missing_fields": [] if enabled_count >= 1 else ["至少勾选一种群类型"],
    }

    # assistant_system: has_assistant + types + has_assistant_manager + booking_rule + forbidden_words
    ast = profile.get("assistant_system", {}) if isinstance(profile.get("assistant_system"), dict) else {}
    if _bool_answered(ast, "has_assistant") and not ast.get("has_assistant"):
        ast_score = 100
        a_missing = []
    elif ast.get("has_assistant"):
        has_types = isinstance(ast.get("assistant_types"), list) and ast.get("assistant_types")
        ast_score = 50 if not has_types else 0
        a_missing = ["assistant_types"] if not has_types else []
        if has_types:
            ast_score = 70
            if _bool_answered(ast, "has_assistant_manager"):
                ast_score += 10
            else:
                a_missing.append("has_assistant_manager")
            if ast.get("assistant_booking_rule"):
                ast_score += 10
            else:
                a_missing.append("assistant_booking_rule")
            ast_score = min(100, ast_score)
            a_missing = [m for m in a_missing if not (
                (m == "has_assistant_manager" and _bool_answered(ast, m)) or
                (m == "assistant_booking_rule" and ast.get(m))
            )]
    else:
        ast_score = 0
        a_missing = ["has_assistant"]
    modules["assistant_system"] = {
        "score": ast_score,
        "completed": ast_score == 100,
        "missing_fields": a_missing,
    }

    # events: has_weekly_match + has_light_competition + has_partner_group
    evt = profile.get("events", {}) if isinstance(profile.get("events"), dict) else {}
    e_fields = ["has_weekly_match", "has_light_competition", "has_partner_group"]
    e_filled = sum(1 for f in e_fields if _bool_answered(evt, f))
    modules["events"] = {
        "score": min(100, int(e_filled / len(e_fields) * 100)) if e_fields else 0,
        "completed": e_filled == len(e_fields),
        "missing_fields": [f for f in e_fields if not _bool_answered(evt, f)],
    }

    # commerce_rules: has_groupbuy + has_membership + allow_discount_copy + allow_price_copy
    comm = profile.get("commerce_rules", {}) if isinstance(profile.get("commerce_rules"), dict) else {}
    cm_fields = ["has_groupbuy", "has_membership", "allow_discount_copy", "allow_price_copy"]
    cm_filled = sum(1 for f in cm_fields if _bool_answered(comm, f))
    modules["commerce_rules"] = {
        "score": min(100, int(cm_filled / len(cm_fields) * 100)) if cm_fields else 0,
        "completed": cm_filled == len(cm_fields),
        "missing_fields": [f for f in cm_fields if not _bool_answered(comm, f)],
    }

    # equipment
    equip = profile.get("equipment", {}) if isinstance(profile.get("equipment"), dict) else {}
    eq_types = isinstance(equip.get("table_types"), list) and equip.get("table_types")
    eq_note = bool(equip.get("table_type_note"))
    eq_filled = (1 if eq_types else 0) + (1 if eq_note else 0)
    modules["equipment"] = {
        "score": min(100, int(eq_filled / 2 * 100)),
        "completed": eq_filled >= 1,
        "missing_fields": ([] if eq_types else ["table_types"]) + ([] if eq_note else ["table_type_note"]),
    }

    # content_style: moments_tone + private_chat_tone + group_notice_tone + forbidden_phrases
    style = profile.get("content_style", {}) if isinstance(profile.get("content_style"), dict) else {}
    s_fields = ["moments_tone", "private_chat_tone", "group_notice_tone"]
    s_filled = sum(1 for f in s_fields if style.get(f))
    s_forbidden = isinstance(style.get("forbidden_phrases"), list) and style.get("forbidden_phrases")
    if s_forbidden:
        s_filled += 1
    s_total = len(s_fields) + 1
    modules["content_style"] = {
        "score": min(100, int(s_filled / s_total * 100)),
        "completed": s_filled >= len(s_fields),
        "missing_fields": [f for f in s_fields if not style.get(f)] + ([] if s_forbidden else ["forbidden_phrases"]),
    }

    # overall
    scores = [m["score"] for m in modules.values()]
    overall = int(sum(scores) / len(scores)) if scores else 0
    completed_modules = [k for k, v in modules.items() if v["completed"]]
    suggested_modules = [k for k, v in modules.items() if not v["completed"]]

    return {
        "overall_score": overall,
        "modules": modules,
        "completed_modules": completed_modules,
        "suggested_modules": suggested_modules,
    }


SCENE_KEYWORDS = {
    "assistant_system": [
        "助教", "新助教", "今日助教", "点助教", "陪玩", "陪打", "预约助教",
        "助教短视频", "助教客户", "陪练", "美女助教", "助教到店",
    ],
    "private_domain_groups.member_group": [
        "会员群", "会员通知", "会员活动", "会员提醒", "会员维护",
    ],
    "private_domain_groups.competition_group": [
        "竞技群", "约局", "周赛", "月赛", "轻竞技", "赛后战报", "缺一位", "练球局",
    ],
    "equipment": [
        "乔氏", "独牙", "斯诺克", "台球桌", "桌型", "设备", "球桌", "换台",
    ],
    "events": [
        "周赛", "月赛", "赛事", "比赛", "报名", "战报",
    ],
    "commerce_rules": [
        "团购", "核销", "会员", "充值", "优惠", "折扣", "价格", "套餐",
    ],
    "content_style": [
        "朋友圈", "语气", "风格", "文案风格",
    ],
}

SCENE_SUGGESTIONS = {
    "assistant_system": {
        "module": "assistant_system",
        "level": "info",
        "title": "建议补充助教体系",
        "message": "你正在生成助教相关内容。补充助教类型（服务体验型/技术陪练型）、预约规则和禁用表达后，AI 生成的助教内容会更准。",
        "action_label": "去补充门店资料",
    },
    "private_domain_groups.member_group": {
        "module": "private_domain_groups",
        "level": "info",
        "title": "建议勾选会员群",
        "message": "你正在生成会员群相关内容。在门店资料里勾选「会员群」后，AI 会更准确地区分会员群通知和普通客户群通知。",
        "action_label": "去勾选会员群",
    },
    "private_domain_groups.competition_group": {
        "module": "private_domain_groups",
        "level": "info",
        "title": "建议勾选竞技群",
        "message": "你正在生成竞技相关内容。在门店资料里勾选「竞技群」后，AI 会更准确处理约局、周赛、轻竞技等内容。",
        "action_label": "去勾选竞技群",
    },
    "equipment": {
        "module": "equipment",
        "level": "info",
        "title": "建议补充台球桌类型",
        "message": "你提到了桌型相关内容。补充门店的台球桌类型（普通/独牙/乔氏/斯诺克）后，AI 在生成赛事和约局内容时会更准确。",
        "action_label": "去补充桌型",
    },
    "events": {
        "module": "events",
        "level": "info",
        "title": "建议补充赛事活动信息",
        "message": "你正在生成赛事相关内容。补充是否有固定周赛、轻竞技活动等信息后，赛事内容会更贴店。",
        "action_label": "去补充赛事信息",
    },
    "commerce_rules": {
        "module": "commerce_rules",
        "level": "info",
        "title": "建议补充团购/会员规则",
        "message": "你提到了团购或价格相关内容。补充团购平台、会员体系和优惠规则后，AI 会更清楚哪些表达安全、哪些需要占位。",
        "action_label": "去补充规则",
    },
    "content_style": {
        "module": "content_style",
        "level": "info",
        "title": "建议补充内容风格",
        "message": "你正在生成朋友圈或话术内容。补充朋友圈语气、禁用表达等信息后，AI 的输出风格会更贴合你的门店。",
        "action_label": "去补充风格",
    },
}


def detect_profile_suggestions(
    profile: dict | None,
    role: str,
    target_customer_type: str | None,
    output_package: list[str] | None,
    user_intent: str,
    extra_note: str = "",
) -> list[dict]:
    """检测用户意图中涉及但门店画像缺失的模块，返回补充建议（不阻塞生成）。"""
    if not profile or not isinstance(profile, dict):
        return []

    completeness = calculate_operation_profile_completeness(profile)
    suggestions: list[dict] = []

    search_text = f"{user_intent} {extra_note}"

    for module_key, keywords in SCENE_KEYWORDS.items():
        # Check if any keyword matches the user intent
        matched = any(kw in search_text for kw in keywords)
        if not matched:
            continue

        # Resolve module status
        base_module = module_key.split(".")[0]
        mod_info = completeness["modules"].get(base_module, {})

        if module_key == "private_domain_groups.member_group":
            groups = profile.get("private_domain_groups", {})
            mg = groups.get("member_group", {}) if isinstance(groups, dict) else {}
            if not mg.get("enabled"):
                suggestions.append(SCENE_SUGGESTIONS[module_key])
        elif module_key == "private_domain_groups.competition_group":
            groups = profile.get("private_domain_groups", {})
            cg = groups.get("competition_group", {}) if isinstance(groups, dict) else {}
            if not cg.get("enabled"):
                suggestions.append(SCENE_SUGGESTIONS[module_key])
        elif module_key == "equipment":
            equip = profile.get("equipment", {}) if isinstance(profile.get("equipment"), dict) else {}
            if not equip.get("table_types"):
                suggestions.append(SCENE_SUGGESTIONS[module_key])
        elif not mod_info.get("completed"):
            suggestions.append(SCENE_SUGGESTIONS[module_key])

    # Deduplicate by module
    seen = set()
    unique = []
    for s in suggestions:
        if s["module"] not in seen:
            seen.add(s["module"])
            unique.append(s)

    # Limit to 3 suggestions max
    return unique[:3]
