# 知识库优化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 挂载 15 个孤儿知识文件到对应角色，新建 3 个缺失知识文件，扩写 5 个现有知识文件，更新产品文档，使知识库从 61% 覆盖率提升到 ~100%。

**Architecture:** 纯内容/配置修改。在角色 rules YAML 中添加 required_knowledge 引用，在 knowledge/ 目录下创建或扩写 YAML 文件，最后更新文档。不涉及代码逻辑变更。

**Tech Stack:** YAML, Markdown, Python (PromptEngine)

---

## 文件结构总览

### 修改文件（6 个角色 rules YAML）

| 文件 | 改动 |
|------|------|
| `server/prompts/rules/role/boss.yaml` | 添加 5 个 required_knowledge |
| `server/prompts/rules/role/manager.yaml` | 添加 4 个 required_knowledge |
| `server/prompts/rules/role/assistant_manager.yaml` | 添加 3 个 required_knowledge |
| `server/prompts/rules/role/coach.yaml` | 添加 1 个 required_knowledge |
| `server/prompts/rules/role/frontdesk.yaml` | 添加 2 个 required_knowledge |
| `server/prompts/rules/role/operator.yaml` | 添加 2 个 required_knowledge |

### 新建文件（3 个知识 YAML）

| 文件 | key |
|------|-----|
| `server/prompts/knowledge/site_selection.yaml` | `knowledge.site_selection` |
| `server/prompts/knowledge/traffic_generation.yaml` | `knowledge.traffic_generation` |
| `server/prompts/knowledge/contract_basics.yaml` | `knowledge.contract_basics` |

### 扩写文件（5 个知识 YAML）

| 文件 | 当前行数 | 目标 |
|------|---------|------|
| `server/prompts/knowledge/frontdesk_training.yaml` | 340 | ~500 行 |
| `server/prompts/knowledge/platform_operations.yaml` | 40 | ~200 行 |
| `server/prompts/knowledge/review_generation_rules.yaml` | 111 | ~400 行 |
| `server/prompts/knowledge/profit_model.yaml` | 294 | ~350 行 |
| `server/prompts/knowledge/daily_workflow_assistant_manager.yaml` | 60 | ~150 行 |

### 更新文档（3 个）

| 文件 | 改动 |
|------|------|
| `docs/product-brain/运营场景索引.md` | 标注新增/修改的知识文件 |
| `docs/README.md` | 更新知识库清单 |
| `CLAUDE.md` | 更新行业知识体系部分 |

---

## Task 1: 挂载孤儿文件到老板角色

**Files:**
- Modify: `server/prompts/rules/role/boss.yaml`

- [ ] **Step 1: 读取当前 boss.yaml 的 required_knowledge**

Read `server/prompts/rules/role/boss.yaml`，确认当前 required_knowledge 列表：

```yaml
required_knowledge:
  - knowledge.core_operations
  - knowledge.profit_model
  - knowledge.industry_data
  - knowledge.performance_standards
  - knowledge.business_cases
  - knowledge.compliance_rules
  - knowledge.customer_types
```

- [ ] **Step 2: 添加新的 required_knowledge**

在 boss.yaml 末尾的 `required_knowledge` 列表中添加：

```yaml
required_knowledge:
  - knowledge.core_operations
  - knowledge.profit_model
  - knowledge.industry_data
  - knowledge.performance_standards
  - knowledge.business_cases
  - knowledge.compliance_rules
  - knowledge.customer_types
  - knowledge.customer_tagging
  - knowledge.opening_preparation
  - knowledge.recharge_strategy
  - knowledge.management_recruitment
  - knowledge.manager_compensation
  - knowledge.core_metrics
  - knowledge.contract_basics
  - knowledge.site_selection
```

- [ ] **Step 3: 验证 YAML 格式**

Run: `cd server && python -c "from services.ai.prompt_engine import get_prompt_engine; pe = get_prompt_engine(); print('boss knowledge:', len(pe._templates.get('rules.role.boss', {}).get('required_knowledge', [])))"`

- [ ] **Step 4: Commit**

```bash
git add server/prompts/rules/role/boss.yaml
git commit -m "feat: 老板角色挂载孤儿知识文件 + 新增选址/合同知识引用"
```

---

## Task 2: 挂载孤儿文件到店长角色

**Files:**
- Modify: `server/prompts/rules/role/manager.yaml`

- [ ] **Step 1: 读取当前 manager.yaml 的 required_knowledge**

确认当前列表为 8 个 key。

- [ ] **Step 2: 添加新的 required_knowledge**

```yaml
required_knowledge:
  - knowledge.core_operations
  - knowledge.tournament_rules
  - knowledge.mini_games
  - knowledge.profit_model
  - knowledge.performance_standards
  - knowledge.compliance_rules
  - knowledge.customer_types
  - knowledge.service_philosophy
  - knowledge.customer_tagging
  - knowledge.customer_profile_template
  - knowledge.opening_preparation
  - knowledge.recharge_strategy
  - knowledge.core_metrics
  - knowledge.review_generation_rules
  - knowledge.daily_workflow_manager
  - knowledge.contract_basics
```

- [ ] **Step 3: 验证 YAML 格式**

Run: `cd server && python -c "from services.ai.prompt_engine import get_prompt_engine; pe = get_prompt_engine(); print('manager knowledge:', len(pe._templates.get('rules.role.manager', {}).get('required_knowledge', [])))"`

- [ ] **Step 4: Commit**

```bash
git add server/prompts/rules/role/manager.yaml
git commit -m "feat: 店长角色挂载孤儿知识文件 + 复盘会/充值策略/合同引用"
```

---

## Task 3: 挂载孤儿文件到助教管理角色

**Files:**
- Modify: `server/prompts/rules/role/assistant_manager.yaml`

- [ ] **Step 1: 读取当前 assistant_manager.yaml 的 required_knowledge**

确认当前列表。

- [ ] **Step 2: 添加新的 required_knowledge**

在现有列表基础上添加：
- `knowledge.customer_tagging`
- `knowledge.customer_profile_template`
- `knowledge.assistant_promotion`
- `knowledge.daily_workflow_assistant_manager`
- `knowledge.traffic_generation`

- [ ] **Step 3: 验证 YAML 格式**

- [ ] **Step 4: Commit**

```bash
git add server/prompts/rules/role/assistant_manager.yaml
git commit -m "feat: 助教管理角色挂载晋升/引流/客户标签知识引用"
```

---

## Task 4: 挂载孤儿文件到教练/前厅/运营角色

**Files:**
- Modify: `server/prompts/rules/role/coach.yaml`
- Modify: `server/prompts/rules/role/frontdesk.yaml`
- Modify: `server/prompts/rules/role/operator.yaml`

- [ ] **Step 1: 教练角色 — 添加 `knowledge.customer_tagging` 和 `knowledge.daily_workflow_coach`**

Read `server/prompts/rules/role/coach.yaml`，找到 `required_knowledge` 列表，添加两个新 key。

- [ ] **Step 2: 前厅角色 — 添加 `knowledge.customer_tagging`、`knowledge.customer_profile_template` 和 `knowledge.daily_workflow_frontdesk`**

Read `server/prompts/rules/role/frontdesk.yaml`，找到 `required_knowledge` 列表，添加三个新 key。

- [ ] **Step 3: 运营角色 — 添加 `knowledge.customer_tagging`、`knowledge.platform_operations` 和 `knowledge.traffic_generation`**

Read `server/prompts/rules/role/operator.yaml`，找到 `required_knowledge` 列表，添加三个新 key。

- [ ] **Step 4: 验证所有 6 个角色的 YAML 格式**

Run: `cd server && python -c "
from services.ai.prompt_engine import get_prompt_engine
pe = get_prompt_engine()
roles = ['boss', 'manager', 'assistant_manager', 'coach', 'frontdesk', 'operator']
for r in roles:
    tpl = pe._templates.get(f'rules.role.{r}', {})
    kws = tpl.get('required_knowledge', [])
    print(f'{r}: {len(kws)} knowledge files')
"`

- [ ] **Step 5: Commit**

```bash
git add server/prompts/rules/role/coach.yaml server/prompts/rules/role/frontdesk.yaml server/prompts/rules/role/operator.yaml
git commit -m "feat: 教练/前厅/运营角色挂载孤儿知识文件"
```

---

## Task 5: 新建选址雷区知识文件

**Files:**
- Create: `server/prompts/knowledge/site_selection.yaml`

- [ ] **Step 1: 创建文件**

```yaml
key: "knowledge.site_selection"
name: "商业球房选址要点"
category: "knowledge"
variables: []
template: |
  ## 商业球房选址 20 个关键要点

  选址是球房经营的第一步，选址错误可能导致整个项目失败。以下是商业球房选址必须核查的 20 个要点：

  ### 场地基础条件
  1. 确定该场地为商业用地
  2. 公摊面积合理，基本上要达到每 40 平米一张球桌
  3. 层高 4 米以上
  4. 场地方正、柱距 8 米以上

  ### 租赁条款
  5. 关注租金水平、免租期、涨幅比例、付款方式、押金
  6. 如有转让费，转让费过大不考虑
  7. 租期建议 5-8 年

  ### 楼层选择
  8. 尽量选二至四层（负一层问题比较多，楼层过高消防难度大）
  9. 商场需签订独家排他协议

  ### 交通与停车
  10. 电梯是否独立且 24 小时运行
  11. 地下停车场是否能提供指引标识
  12. 停车位足够，能否提供私人停车位，免费停车 3 小时以上

  ### 广告与形象
  13. 广告位面积：外招牌最低需要 6-10 个平方
  14. 能否在电梯和停车场设置指引标识

  ### 设施设备
  15. 用电保障：每 100 平米保证 10 千瓦
  16. 落实商业用电价格，确认是否有公摊服务费
  17. 空调自行安装，要求能提供空调主机安装位置
  18. 能否提供原始 CAD 图纸（必须复尺）

  ### 消防与合规
  19. 物业必须通过一次消防，是否能为二消提供帮助
  20. 产权没有纠纷，落实租赁前是否有抵押

  ### 附加注意事项
  - 如楼上是小区，测试是否构成扰民带来投诉（基本不建议）
  - 要求物业提供免费的临时筹备办公室（50 平以上）
  - 很多球房从一开始就是错的，定位看生死
  - 品牌连锁的商业球房会逐渐抢占市场，中小型球房的市场份额会越来越低
```

- [ ] **Step 2: 验证 YAML 格式**

Run: `cd server && python -c "from services.ai.prompt_engine import get_prompt_engine; pe = get_prompt_engine(); print('site_selection loaded:', 'knowledge.site_selection' in pe._templates)"`

- [ ] **Step 3: Commit**

```bash
git add server/prompts/knowledge/site_selection.yaml
git commit -m "feat: 新增选址雷区知识文件（20个要点）"
```

---

## Task 6: 新建引流操作手册知识文件

**Files:**
- Create: `server/prompts/knowledge/traffic_generation.yaml`

- [ ] **Step 1: 创建文件**

```yaml
key: "knowledge.traffic_generation"
name: "球房引流操作手册"
category: "knowledge"
variables: []
template: |
  ## 球房引流体系

  引流是球房经营的命脉，没有客流就没有一切。引流分为线上和线下两大渠道。

  ### 一、线上引流

  #### 1. 短视频引流
  - 抖音、视频号、快手、小红书同城
  - 内容方向：球房环境展示、助教教学片段、赛事精彩瞬间、客户打球花絮
  - 核心目的：加微信，从公域导流到私域
  - 注意事项：擦边内容不能带球台画面，避免平台审核风险

  #### 2. 直播引流
  - 助教轮流直播，直播手机不能停
  - 直播内容：打球教学、花式表演、与观众互动
  - 每组助教每天直播不少于 2 小时

  #### 3. 交友平台引流
  - 积目、陌陌、Soul、探探等
  - 以加微信为主，适当高冷但不能让话题死
  - 加微信平均分配主动加和被加

  #### 4. 美团/大众点评
  - 设置爆款商品（最多 5 个）
  - 评分目标：及格 4.6，良好 4.8，优秀 4.9
  - 美团评价要求：3 张图片 + 15 字以上文字
  - 评价前关闭门店 WiFi，使用自己的流量
  - 同一账号每天只能评价一次，下次评价至少隔天
  - 验券后需间隔 20 分钟再评价

  ### 二、线下引流

  #### 1. 地推拓客
  - 划分区域（东区、中区、西区等），分组每日轮换
  - 两人一小组，一人介绍活动，一人负责办卡加微
  - 地推形式：展点、海派、扫楼、插车
  - 关键时间点：写字楼中午、商业街晚上 6 点后、企事业单位下班时间

  #### 2. 异业联盟
  - 与周边不同行业商家合作，互相引流
  - 植入展架广告，互相赠送代金券等增值服务
  - 增加球房曝光度，导入精准客户

  #### 3. 地推话术要点
  - 话术要简洁易懂，让路过的人一听就明白
  - 示例：「球房即将开业，台费卡 199 抵 500，相当于 4 折，折算下来打普台 XX 元/小时，先生给您办一张吧」

  #### 4. 地推数据管理
  - 每日地推结束后开总结大会
  - 办卡好的员工上台分享技巧
  - 数据汇总：办卡数、金额、加微数、拉群数
  - 办卡奖励：每张卡奖励 30 元

  ### 三、引流数据参考

  #### 美团经营评分达成要点
  1. 聊天监控：不要以文字发送给客户关于做评价的信息
  2. 定位监控：评价前后三天内必须定位到过店，不要远程验券评价
  3. 打字输入速度：不要复制粘贴
  4. 老会员评价周期至少间隔一周以上
  5. 每日评价不超过 10 条

  #### 大众点评星级达成
  - 到店打开大众点评 → 屏幕左下角打卡 → 打卡成功后 30 分钟后可以评价
  - 3 张图片 + 15 个文字（每日最多 5 条）
```

- [ ] **Step 2: 验证 YAML 格式**

- [ ] **Step 3: Commit**

```bash
git add server/prompts/knowledge/traffic_generation.yaml
git commit -m "feat: 新增引流操作手册（线上+线下+数据管理）"
```

---

## Task 7: 新建合同知识文件

**Files:**
- Create: `server/prompts/knowledge/contract_basics.yaml`

- [ ] **Step 1: 创建文件**

```yaml
key: "knowledge.contract_basics"
name: "球房合同基础知识"
category: "knowledge"
variables: []
template: |
  ## 球房合同与法律基础

  球房经营涉及多种合同和法律文件，以下是核心要点。

  ### 一、助教合作协议核心条款

  #### 合同期限
  - 有效期一般为 1 年，合同期满提前一个月书面续约
  - 试用期前两个月有保底薪酬保障

  #### 工作内容
  - 指导学员掌握台球技巧，维护球房秩序
  - 协助教练进行教学计划制定和实施
  - 负责维护教学场所整洁和安全
  - 协助组织学员参加比赛和活动
  - 向客人营销球房商品及会员卡

  #### 工作时间
  - 一般为 13:00—24:00（根据实际营业时间调整）
  - 每月休息 4 天，周末（五、六、日）除外
  - 周末请假视情况扣除相应报酬

  #### 报酬结构
  - 保底报酬：根据级别不同（初级/中级/高级/星级），保底金额不同
  - 浮动报酬：按实际课时计算，每小时报酬根据级别递增
  - 完成月度课时任务可享受全额保底
  - 未完成课时按实际业绩提成计算

  #### 工作纪律
  - 工作时间严禁与内部人员以外客人免费打球
  - 严禁向客人索要任何财物
  - 工作时间严禁以任何理由与客人外出
  - 迟到赔偿：10 分钟内 50 元，60 分钟内 100 元
  - 旷工赔偿：每天 500 元，三次以上视为自动离职

  #### 安全责任
  - 员工应如实告知健康状况
  - 遵守服务规则，不做超出工作内容的服务
  - 非工作场所引发的人身安全由员工自行承担

  #### 肖像权
  - 员工自愿按要求拍摄宣传素材
  - 球房有权将作品用于各项业务及宣传活动

  #### 竞业禁止
  - 合同期内不得在其他球房从事相同或类似工作
  - 合同期满后不得劝诱、聘用球房其他员工
  - 违反竞业禁止需赔偿违约金

  #### 保密条款
  - 不得泄露球房商业秘密、客户信息
  - 合同期满后仍需遵守保密义务

  #### 违约责任
  - 任何一方违反合同规定需承担违约责任
  - 员工提前解除合同需提前一个月书面通知

  ### 二、BOSS 直聘招聘合规要点

  #### 严禁事项
  - 岗位描述不能出现「陪」字及其变体（陪练、陪同打球、陪伴客户）
  - 不能问外貌相关问题（身材、生活照、身高体重）
  - 不能提情商、酒量等与陪酒相关的词

  #### 合规写法
  - 正确名称：台球教练、台球指导员、台球课程顾问
  - 工作内容：提供台球基础动作指导和规则讲解、组织小型友谊赛、维护球房秩序
  - 薪资设置：市场中位值上浮 15%，不要写过高薪资

  #### 账号被锁处理
  1. 自查所有职位描述，换成合规版本
  2. 申诉时态度诚恳，表示已学习平台规范
  3. 准备营业执照、法人身份证、门头照片、店内环境视频
```

- [ ] **Step 2: 验证 YAML 格式**

- [ ] **Step 3: Commit**

```bash
git add server/prompts/knowledge/contract_basics.yaml
git commit -m "feat: 新增合同知识文件（合作协议+招聘合规）"
```

---

## Task 8: 扩写前厅培训知识文件

**Files:**
- Modify: `server/prompts/knowledge/frontdesk_training.yaml`

- [ ] **Step 1: 读取当前文件**

Read `server/prompts/knowledge/frontdesk_training.yaml`（340 行），了解当前内容结构。

- [ ] **Step 2: 在 template 部分末尾追加服务完整链路**

在 `template` 字段的末尾（在最后的 `---` 之前）追加以下内容：

```markdown
  ### 服务完整链路（门迎→接待→加微信→分类→维客）

  #### 第一步：门迎接待
  - 客户进门时主动打招呼：「您好，欢迎光临！请问有预订吗？」
  - 有预订：引导至对应球台
  - 无预订：核实空台情况后报价，引导开台

  #### 第二步：开台引导
  - 带客户到球台过程中询问是否需要助教
  - 如客户有兴趣，根据需求推荐合适类型
  - 询问是否需要饮料等消费

  #### 第三步：二次维客（开台后 10-30 分钟）
  - 送上饮料或主动关怀
  - 自我介绍并请求添加微信
  - 话术：「我是这边的客户经理某某，方便加您微信吗？下次过来可以直接微信订台」

  #### 第四步：微信分类
  - 添加微信后发文字感谢 + 个人简介
  - 根据客户特征分类：
    - A 类：消费能力强，对包厢和助教有需求
    - B 类：有一定消费力，经常点助教或追分
    - C 类：球厅熟面孔，多次团购或竞技
    - D 类：路过或薅羊毛客户
  - 备注公式：品牌标识 + 客户类别 + 姓名 + 简单习惯

  #### 第五步：后续维客
  - 定期发送活动信息和优惠政策
  - 根据客户类别推送差异化内容
  - A/B 类客户重点关注，定期邀约到店
```

- [ ] **Step 3: 验证 YAML 格式**

Run: `cd server && python -c "from services.ai.prompt_engine import get_prompt_engine; pe = get_prompt_engine(); t = pe._templates.get('knowledge.frontdesk_training', {}); print('lines:', len(t.get('template', '').split(chr(10))))"`

- [ ] **Step 4: Commit**

```bash
git add server/prompts/knowledge/frontdesk_training.yaml
git commit -m "feat: 前厅培训知识文件追加服务完整链路（5步流程）"
```

---

## Task 9: 扩写平台运营知识文件

**Files:**
- Modify: `server/prompts/knowledge/platform_operations.yaml`

- [ ] **Step 1: 读取当前文件**

Read `server/prompts/knowledge/platform_operations.yaml`（40 行）。

- [ ] **Step 2: 重写为完整的平台运营手册**

将文件内容替换为以下完整版本（保持 key/name/category/variables 不变，只替换 template）：

```yaml
key: "knowledge.platform_operations"
name: "美团与抖音运营操作手册"
category: "knowledge"
variables: []
template: |
  ## 美团与抖音运营操作手册

  ### 一、美团运营

  #### 1. 店铺评分管理
  - 及格线：4.6 分；良好：4.8 分；优秀：4.9 分
  - 美团每天评价不超过 10 条
  - 每条评价要求：3 张图片 + 15 字以上文字

  #### 2. 评价操作规范
  - 评价前关闭门店 WiFi，使用自己的流量
  - 评价前需关闭手机定位服务（在门店内评价时）
  - 同一账号每天只能评价一次，下次评价至少隔天
  - 验券后需间隔 20 分钟再评价，不能验券后立马评价
  - 差评回复要当天回复，最迟隔天回复，用门店账号回复
  - 差评回复后需联系平台客服协助处理

  #### 3. 团购产品设计
  - 品类最多 5 个，品类太多不利于爆款单量积累
  - 设置引流区低价产品（如新人 9.9 元/小时）
  - 设置爆款产品（如乔氏银腿特价）
  - 图文并茂，场景展示和美女展示结合

  #### 4. 美团经营评分达成操作
  - 进入开店宝后台 → 经营评分模块 → 评分任务单元 → 学习和完成任务

  #### 5. 美团星级达成五个要点
  1. 聊天监控：不要以文字发送给客户关于做评价的信息
  2. 定位监控：评价前后三天内必须定位到过店
  3. 打字输入速度：不要复制粘贴
  4. 老会员评价周期至少间隔一周以上
  5. 具体评价数量按门店指标执行

  ### 二、抖音运营

  #### 1. 短视频矩阵
  - 员工抖音矩阵推广：短视频 + 直播
  - 流量型内容：擦边（注意平台规则）
  - 获客型内容：产品卖点展示
  - 内容方向：球房环境、助教教学、赛事精彩、客户花絮

  #### 2. 直播运营
  - 助教轮流直播，直播手机不能停
  - 每组助教每天直播不少于 2 小时
  - 直播内容：打球教学、花式表演、互动

  #### 3. 抖音本地推
  - 投放本地同城流量
  - 小城市做本地网红，大城市做区域网红

  #### 4. 大众点评运营
  - 到店打卡 → 30 分钟后评价
  - 3 张图片 + 15 个文字
  - 每日最多 5 条评价

  ### 三、内容发布规范

  #### 朋友圈发布要求
  - 每天至少 2 条
  - 内容类型：活动发布、赛事发布、助教笔记、器材维护、充值喜报、好评展示
  - 带话题标签：#城市名台球 #台球 #球房名
  - 避免：纯广告、刷屏、负面内容

  #### 短视频发布要求
  - 每月至少 15 条（定位 + 团购）
  - 单条视频破万播放量奖励 50 元
  - 爆款视频奖励 100 元
```

- [ ] **Step 3: 验证 YAML 格式**

- [ ] **Step 4: Commit**

```bash
git add server/prompts/knowledge/platform_operations.yaml
git commit -m "feat: 平台运营知识文件扩写为完整操作手册"
```

---

## Task 10: 扩写复盘会规则知识文件

**Files:**
- Modify: `server/prompts/knowledge/review_generation_rules.yaml`

- [ ] **Step 1: 读取当前文件**

Read `server/prompts/knowledge/review_generation_rules.yaml`（111 行）。

- [ ] **Step 2: 在 template 部分末尾追加完整复盘会流程**

在 `template` 字段末尾追加：

```markdown
  ### 复盘会完整流程

  #### 会前准备（会前 1 天）
  - 店长收集各岗位数据：台费、助教费、商品费、充值、好评
  - 准备上期复盘会遗留问题的跟进情况
  - 通知参会人员时间、地点、需准备的资料

  #### 会议流程（建议时长 60-90 分钟）

  **第一环节：数据回顾（15 分钟）**
  - 店长汇报本月/本周核心数据
  - 对比上期数据，标注增长/下降项
  - 重点分析异常数据（如某项指标突然下降）

  **第二环节：各岗位复盘（30 分钟）**
  - 助教管理：助教团队数据、招聘情况、流失率
  - 教练：赛事数据、竞技客户增长、会员赛情况
  - 前厅：商品销售、好评数据、客户投诉处理
  - 运营：线上曝光数据、内容产出、团购核销

  **第三环节：问题分析（20 分钟）**
  - 各岗位提出本周期遇到的问题
  - 集体讨论解决方案
  - 明确责任人和完成时间

  **第四环节：下期目标（15 分钟）**
  - 各岗位设定下周期具体目标
  - 明确关键动作和时间节点
  - 店长总结并确认执行计划

  #### 会后跟进
  - 店长整理会议纪要，发到管理群
  - 各责任人按计划执行
  - 下次复盘会首先检查上期遗留问题

  #### 复盘会注意事项
  - 不要只报喜不报忧，问题要摆在台面上
  - 数据要真实，不要美化
  - 解决方案要具体可执行，不要空话
  - 控制时间，避免跑题
```

- [ ] **Step 3: 验证 YAML 格式**

- [ ] **Step 4: Commit**

```bash
git add server/prompts/knowledge/review_generation_rules.yaml
git commit -m "feat: 复盘会规则知识文件追加完整会议流程"
```

---

## Task 11: 扩写利润模型知识文件

**Files:**
- Modify: `server/prompts/knowledge/profit_model.yaml`

- [ ] **Step 1: 读取当前文件**

Read `server/prompts/knowledge/profit_model.yaml`（294 行）。

- [ ] **Step 2: 在 template 部分末尾追加定价操作步骤**

在 `template` 字段末尾追加：

```markdown
  ### 定价操作步骤

  #### 1. 取消大额充值赠送的操作流程
  - 第一步：管理层培训，统一认知
  - 第二步：下架充值价目表
  - 第三步：向客户提示最后一次大额赠送机会
  - 第四步：后续充值改为送台费券（小额度）

  #### 2. 一卡通模式设计
  - 取消传统会员卡，改为一卡通
  - 充值金额全场通用（台费+商品+助教）
  - 赠送金额仅限消费台位费
  - 示例：充 1000 送 99、充 3000 送 399、充 5000 送 799、充 10000 送 1999

  #### 3. 线上团购产品优化
  - 抖音/美团页面增加场馆美图，突出球台品牌
  - 团购品类优化，设置爆款产品
  - 引流区：新人 9.9 元/小时，不限时段
  - 团购产品类别减少至 4-5 个
  - 管理层每天主动向客户要好评

  #### 4. 定价调整技巧
  - 价格尾数「8」调为「9」（心理定价）
  - 取消长期促销，改为阶段性活动
  - 根据实际台费均价调整，不要虚高
```

- [ ] **Step 3: 验证 YAML 格式**

- [ ] **Step 4: Commit**

```bash
git add server/prompts/knowledge/profit_model.yaml
git commit -m "feat: 利润模型知识文件追加定价操作步骤"
```

---

## Task 12: 扩写助教管理日常流程知识文件

**Files:**
- Modify: `server/prompts/knowledge/daily_workflow_assistant_manager.yaml`

- [ ] **Step 1: 读取当前文件**

Read `server/prompts/knowledge/daily_workflow_assistant_manager.yaml`（60 行）。

- [ ] **Step 2: 重写为详细的一日工作时间表**

将 template 部分替换为完整的助教管理一日工作流程：

```yaml
key: "knowledge.daily_workflow_assistant_manager"
name: "助教管理一日工作流程"
category: "knowledge"
variables: []
template: |
  ## 助教管理一日工作流程

  ### 三大核心方向
  1. 打开助教思维
  2. 维客拓客能力（核心）
  3. 带助教赚钱

  ### 重点工作提示
  - 助教管理和助教间关系维护
  - 助教的每一步动作都要对助教管理进行报备
  - 助教管理必须实时知道助教的情况，方便安排

  ### 详细时间表

  #### 13:50 到店准备
  1. 检查到店助教的仪容仪表（穿着、妆容、工号牌），发现不规范及时纠正
  2. 观察助教情绪，有情绪不对的单独疏导

  #### 14:00-14:30 一对一工作沟通
  1. 总结昨日工作，给助教布置今天工作
  2. 检查助教朋友圈、短视频发布情况，带话题标签
  3. 安排助教轮流直播（直播手机不能停）
  4. 人情世故方面：提前告知助教给客户点奶茶、小吃水果，加深客情
  5. 检查助教轮流派赛工作，不允许断岗
  6. 包间客户，助教管理必须进去打招呼维护客情

  #### 14:30-15:30 维护客户
  1. 维护自己手里的客户，线上维护拉进客情关系
  2. 邀约客户（盘点客户时邀约意向客户到店）
  3. 检查助教维客拓客动作，未达标进行一对一教学

  #### 15:30-16:30 拓客培训
  1. 协助助教维客（拓客）
  2. 注重助教的拓客动作
  3. 培训助教进行营销
  4. 社交软件聊天导入朋友圈

  #### 16:30-17:00 检查直播
  1. 检查助教直播情况，督促助教直播（每天每组必须直播够 2 小时）
  2. 巡场，检查助教是否有扎堆情况

  #### 17:00-18:00 练球与招聘
  1. 检查助教练球，没有约上客户的安排练球
  2. 培训助教主动上桌找客户聊天
  3. 刷 BOSS 直聘招聘助教

  #### 18:00-18:45 用餐时间

  #### 18:45-00:00 晚场工作
  1. 助教管理门迎接待顾客（管理层轮流门迎，每半小时轮换）
  2. 门迎带着没有约到客户的助教，以推助教为主
  3. 检查助教约客情况，未约到客户的由助教管理带领免费体验转化
  4. 免费体验时间控制在 10-15 分钟内
  5. 陪打过程中助教需与顾客沟通，助教管理协助加客户微信
  6. 检查顾客离场后是否发消息关心维护客情

  #### 00:00-00:20 每日例会
  1. 检查并核对每位助教日报
  2. 提出今天发现的问题，提出针对性解决方案
  3. 汇报各小组今日考勤、上课情况、存在问题、招聘情况

  #### 00:20-00:30 日报总结
  1. 日报总结汇报
  2. 助教管理进行每日数据更新
  3. 今日工作总结，明日计划安排
  4. 刷 BOSS 直聘招助教
```

- [ ] **Step 3: 验证 YAML 格式**

- [ ] **Step 4: Commit**

```bash
git add server/prompts/knowledge/daily_workflow_assistant_manager.yaml
git commit -m "feat: 助教管理日常流程扩写为详细时间表（13:50-00:30）"
```

---

## Task 13: 更新产品文档

**Files:**
- Modify: `docs/product-brain/运营场景索引.md`
- Modify: `docs/README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: 更新运营场景索引**

Read `docs/product-brain/运营场景索引.md`，在知识库部分标注：
- 新增文件：`site_selection`、`traffic_generation`、`contract_basics`
- 修改文件：`frontdesk_training`、`platform_operations`、`review_generation_rules`、`profit_model`、`daily_workflow_assistant_manager`
- 挂载变更：15 个孤儿文件已挂载到对应角色

- [ ] **Step 2: 更新 docs/README.md**

Read `docs/README.md`，更新知识文件清单，标注新增和修改的文件。

- [ ] **Step 3: 更新 CLAUDE.md**

Read `CLAUDE.md`，更新"行业知识体系"部分：
- 知识文件数量从 38 更新为 ~42
- 补充新增文件的名称和说明

- [ ] **Step 4: Commit**

```bash
git add docs/product-brain/运营场景索引.md docs/README.md CLAUDE.md
git commit -m "docs: 更新产品文档 — 知识库清单和行业知识体系"
```

---

## Task 14: 验证

- [ ] **Step 1: 验证所有知识文件的 key 唯一性**

Run: `cd server && python -c "
import yaml, os
keys = {}
for f in os.listdir('prompts/knowledge'):
    if f.endswith('.yaml'):
        with open(f'prompts/knowledge/{f}') as fh:
            data = yaml.safe_load(fh)
            key = data.get('key', '')
            if key in keys:
                print(f'DUPLICATE: {key} in {f} and {keys[key]}')
            keys[key] = f
print(f'Total knowledge files: {len(keys)}')
print('All keys unique:', len(keys) == len(set(keys.keys())))
"`

- [ ] **Step 2: 验证所有 required_knowledge 引用的 key 都存在**

Run: `cd server && python -c "
import yaml, os
# Load all knowledge keys
knowledge_keys = set()
for f in os.listdir('prompts/knowledge'):
    if f.endswith('.yaml'):
        with open(f'prompts/knowledge/{f}') as fh:
            data = yaml.safe_load(fh)
            knowledge_keys.add(data.get('key', ''))

# Check all role references
for f in os.listdir('prompts/rules/role'):
    if f.endswith('.yaml'):
        with open(f'prompts/rules/role/{f}') as fh:
            data = yaml.safe_load(fh)
            refs = data.get('required_knowledge', [])
            missing = [k for k in refs if k not in knowledge_keys]
            if missing:
                print(f'{f}: MISSING {missing}')
            else:
                print(f'{f}: OK ({len(refs)} refs)')
"`

- [ ] **Step 3: 验证无第三方品牌名**

Run: `grep -r "唐希\|彬利烎\|某门店\|某门店\|开火体育\|小满桌球" server/prompts/knowledge/ || echo "No third-party brands found"`

- [ ] **Step 4: 最终 Commit**

```bash
git add -A
git commit -m "feat: 知识库优化完成 — 挂载孤儿文件+新建+扩写+文档更新"
```
