# 高德地图 MCP Server 调研

> 📌 状态:✅现行 · 调研日期 2026-07-11 · 外部调研子代理产出
> 范围:官方 MCP 接入方式 / Key 与额度 / 工具清单 / 非官方实现对比 / 给桌面助手的接法建议

## 一、大白话结论(先看这个)

1. **高德官方就有 MCP Server,而且是托管好的远程服务**——一个 URL 加上 key 就能用(`https://mcp.amap.com/mcp?key=你的key`),不用装任何东西。也有本地 npx 包,但远程版工具更多、更省事。
2. **Key 必须要**,三种接入方式都要。没 key 或假 key 直接返回 `INVALID_USER_KEY`(本机实测)。
3. **个人开发者就能申请 Key**:高德控制台注册 → 支付宝扫码实名 → 建应用 → 添加 Key(服务平台选「Web 服务」)。全程免费,但对不懂技术的店主来说还是太绕。
4. **免费额度分桶、瓶颈在搜索和天气**:个人认证每月——路线/地理编码这类 15 万次(宽裕),但**周边搜索和天气各只有 5,000 次/月**(紧)。企业认证搜索提到 5 万/月。超额付费便宜到忽略不计(30 元/万次)。
5. **给店主助手的最顺接法 = owner 一把 key + 走我们自己网关反代官方远程 MCP**,客户端零配置,key 藏在服务器(和现有生图/模型网关同一个模式)。让店主自己申请 key 不现实(要实名认证+建应用,目标用户干不了),只留作 BYOK 高级档。
6. **一个合规雷要知道**:高德官方条款写明「商业目的使用需购买技术服务许可」,基础版 ¥50,000/年。卖给店主的商用软件严格说踩这条。量小的时候没人查,正式上量前要么买授权、要么砍掉高德换免费源(天气有免费替代,POI/路线没有)。**风险提示一次,决定权在产品。**

---

## 二、官方 MCP Server 详情

### 2.1 接入方式(三种,都要 Key)

| 方式 | 地址/命令 | Key 怎么传 | 来源 |
|------|-----------|-----------|------|
| **Streamable HTTP(官方推荐)** | `https://mcp.amap.com/mcp?key=你的key` | URL 参数 | **官方**(lbs.amap.com/api/mcp-server/gettingstarted 原文 JSON 示例)+ **一手实测**(curl 端点存在) |
| SSE | `https://mcp.amap.com/sse?key=你的key` | URL 参数 | **二手**(知乎/腾讯云/多篇教程一致)+ **一手实测**(curl 该端点真实存在,无 key 返回 `{"status":"0","info":"INVALID_USER_KEY","infocode":"10001"}`) |
| 本地 npx | `npx -y @amap/amap-maps-mcp-server` | 环境变量 `AMAP_MAPS_API_KEY` | **官方**(gettingstarted 页原文 + npm 官方包 `@amap/amap-maps-mcp-server`,maintainers 含 alibaba-inc.com 邮箱,2025-03 首发、2026-03 仍在更新) |

官方 gettingstarted 页的推荐配置原文:

```json
{
  "mcpServers": {
    "amap-maps-streamableHTTP": {
      "url": "https://mcp.amap.com/mcp?key=您在高德官网上申请的key"
    }
  }
}
```

本地 npx 要求 Node ≥ v22.14.0(官方)。支持任意 MCP 客户端(Cursor/Claude/Cline,官方原文)。

### 2.2 Key 申请流程(官方文档 lbs.amap.com/api/mcp-server/create-project-and-key)

1. 登录高德开放平台控制台 console.amap.com,没账号先注册成为开发者;
2. 【应用管理】→【创建新应用】;
3. 选中应用 →【添加 Key】,**服务平台选【Web 服务】**(官方原文,MCP 用的就是 Web 服务 Key);
4. 创建成功拿到 Key 和安全密钥。

**实名认证**:注册开发者需实名。个人开发者 = 填姓名/手机/邮箱 + **支付宝扫码实名认证**(二手,CSDN/知乎多篇教程一致,官方 FAQ 未列材料细节)。企业认证 = 企业支付宝授权 / 组织授权 / 对公打款三选一(官方 FAQ)。**个人开发者可以申请**,可用除「智能硬件定位」外的全部服务(官方 FAQ lbs.amap.com/faq/account/certification/39670)。

### 2.3 免费额度(官方定价页 lbs.amap.com/upgrade,2025-05-20 新政后口径)

按**月**计、按服务桶分(不是笼统一个数):

| 服务桶 | 覆盖的 MCP 工具 | 个人认证 | 企业认证 | 超额价 |
|--------|----------------|---------|---------|--------|
| 基础 LBS 服务 | 地理编码/逆地理编码/IP定位/各类路径规划/距离测量 | **150,000 次/月** | 3,000,000 次/月 | 30 元/万次(阶梯打折至 24/18 元) |
| 基础搜索服务 | 关键词搜索/周边搜索/详情搜索 | **5,000 次/月** ⚠️ | 50,000 次/月 | 30 元/万次 |
| 天气预报 | 天气查询 | **5,000 次/月** ⚠️ | 5,000 次/月(企业也这个数) | 30 元/万次 |
| 基础地图定位 | (JS/SDK 端定位,MCP 基本不吃) | 1,500,000 次/月 | 30,000,000 次/月 | 3 元/万次 |

- **QPS 并发限制**:公开文档不给具体数,官方指去「控制台-流量分析-配额管理」看(官方 flowlevel 页)。网上流传的"个人天气 QPS 200"等数字是 2021-2022 旧口径,**别引用**(未找到当前官方公开数)。
- 超额不会自动扣费:免费额度用完直接拒绝请求;要继续用需绑定支付并手动开启按量付费(二手,多源一致)。
- ⚠️ 二手文章里"每日 5000 次""每月 1 万次跨服务共享"等说法是旧政策或以讹传讹,**以官方 /upgrade 页为准**。

### 2.4 工具清单

**远程版(mcp.amap.com)15 个工具**(官方 lbs.amap.com/api/mcp-server/summary):

- 地址转换:地理编码、逆地理编码
- 定位:IP 定位
- 查询:**天气查询、关键词搜索、周边搜索、详情搜索**
- 路径规划:驾车、步行、骑行(≤500km)、公交(跨城综合)
- 测量:距离测量
- **App 联动 3 件套(远程版独有)**:生成专属地图、导航到目的地、打车(唤起高德 App,2025-05 升级加入)

**本地 npx 版 12 个工具**(一手实测:解包 npm 0.0.8 提取):`maps_geo / maps_regeocode / maps_ip_location / maps_weather / maps_text_search / maps_around_search / maps_search_detail / maps_direction_driving / maps_direction_walking / maps_bicycling / maps_direction_transit_integrated / maps_distance`——没有 App 联动 3 件套。

**计费归属(一手实测推断)**:npx 包源码里全部工具都打 `restapi.amap.com/v3|v4` Web 服务 API,远程版错误格式也和 restapi 一致(`infocode 10001`)——**MCP 调用就是消耗上表的 Web 服务配额,没有独立的"MCP 免费额度"**(未找到任何 MCP 专属配额政策)。

### 2.5 商业授权(合规雷,官方条款)

- 官方商用服务条款(lbs.amap.com/pages/authorization/)+ 服务协议(lbs.amap.com/pages/terms/):**法人或组织以商业目的使用**——包括「向第三方或公众用户收费、参与投标、用于内部管理系统、以及任何其他直接或间接获取收益的用途」——**需事先购买技术服务许可**(二手引官方协议原文,官方定价页确认价格)。
- 价格:**基础版 ¥50,000/年、高级版 ¥100,000/年**(官方 /upgrade 页)。
- 个人认证免费额度限定「以个人研究学习目的使用」(官方服务协议,多源引用一致)。
- 违规后果:高德有权无责收回配额、停服、封号(官方条款原文);近两年高德对商用未授权开始发函催缴(二手,CSDN/DCloud 社区多帖)。
- 另注意:官方技术许可协议明确,**用于「模型或算法训练及数据集构建」需专门书面许可**(一手抓取原文)——我们只是运行时调用不算训练,但别拿返回数据建库。

---

## 三、GitHub 非官方实现对比

GitHub 搜 `amap mcp` 共 56 仓,有含金量的:

| 仓库 | Star | 语言 | 特点 | 更新 |
|------|------|------|------|------|
| **sugarforever/amap-mcp-server** | 116 | Python | 发布在 PyPI(`amap-mcp-server`),自托管支持 stdio/SSE/streamable-http;工具对齐官方 12 个,**另加「地址版」路径规划**(`maps_direction_walking_by_address` 等,免去先调地理编码再规划的两步) | 2026-07 活跃 |
| zxypro1/amap-maps-mcp-server | 23 | JS | 即官方 npm 包 `@amap/amap-maps-mcp-server` 同源代码 | 2026-06 |
| ACAne0320/amap-weather-mcp-server | 16 | Python | 只做天气查询 | 2026-07 |
| Keldon-Pro/amap-mcp-streamable_http | 3 | TS | Streamable HTTP 自托管示例 | 2026-03 |
| 其余 | ≤9 | - | 多为 demo/教程配套 | - |

**结论(来源:GitHub API 一手)**:所有非官方实现**都照样需要高德 Key**,没有任何一个绕开;价值仅在换语言/自托管传输/加便利工具(地址版规划这个点子可以抄)。既然官方远程版零部署、工具最全、由高德维护,非官方实现对我们没有替代价值——除非要自托管改造(比如在自家网关内嵌一个,见下)。

---

## 四、给我们产品的接法建议(店主桌面助手内置 查周边/路线/天气)

### 4.1 最顺接法:owner 一把 key + 自家网关反代官方远程 MCP ✅ 推荐

```
客户端(内核 MCP client,官方 mcp SDK 已在用)
   → owner 网关(qfgw,反代 + 注入 key,复用现有"藏 key 白标"模式)
   → https://mcp.amap.com/mcp?key=OWNER_KEY (官方托管,高德维护)
```

理由:
- **零客户端配置**,符合「全内置 key 开箱即用」产品铁律;key 永不落客户端(项目有过"key 打进 asar 被扒"的教训,直接 `mcp.amap.com/mcp?key=xx` 写死在客户端 = key 明文可扒,**必须走网关**)。
- 内核已有 MCP 客户端支持(官方 `mcp` SDK),Streamable HTTP 反代是纯 HTTP 转发,网关加一条路由即可,代码量最小;restapi/mcp.amap.com 都在大陆,走国内 qfgw 网关(39.106.214.21)延迟最低,不需要美国 relay。
- 工具全(15 个含 App 联动),高德自己维护升级,不用追 API 变更。
- 顺手可做:网关侧按 app 令牌对搜索/天气两个紧桶做 per-user 限速,防单用户烧光全池配额。

**备选 B(自封装,不走 MCP)**:后端直接把 restapi.amap.com 的 5-6 个 Web API(geocode/around/weather/direction/distance)封成自家工具,借鉴 sugarforever 的「地址版」设计。好处是工具描述可自己调优、可白标、砍掉用不上的打车/导航;代价是自己维护十来个薄封装。**如果后续发现 MCP 工具描述喂给非 Claude 模型效果差(工具太多/描述太长),再切这条**,当前先走反代最省事。

**天气单项备选**:只要天气的话,Open-Meteo / wttr.in 全球免费无 key 无限量,可作为高德天气 5,000 次/月桶爆掉后的兜底;但**周边 POI 和路线在中国没有免费替代**(百度/腾讯同样要 key、政策同款,OSM 国内 POI 数据太差),高德不可绕。

### 4.2 Key 归属:owner 内置 vs 用户自申

| 方案 | 判定 |
|------|------|
| **用户自己申请** | ❌ 不做默认。店主要:注册高德开发者 → 支付宝实名 → 建应用 → 选「Web 服务」平台 → 复制 key 回填——对"不懂技术的店主"是五步劝退流程,违背零配置铁律。**留作 BYOK 高级档**(和模型 BYOK 同层),自带 key 者流量走自己的池。 |
| **owner 一把 key 内置** | ✅ 默认。限流账见下。 |

**限流账(基于官方额度算)**:
- 路线/地理编码桶(15万/月个人认证):按每用户日均 3 次路线查询,能撑 ~1,600 个日活用户,**宽裕**。
- **搜索桶是真瓶颈**:个人认证 5,000/月 ≈ 每天 166 次全池共享——每用户日均 2 次周边搜索的话,**80 个日活就顶满**。企业认证 5 万/月撑 800 日活。
- 天气桶同为 5,000/月(企业认证也不涨),同级瓶颈,但可切 Open-Meteo 兜底。
- **超额付费便宜到不构成决策因素**:30 元/万次,就算全池月超 10 万次搜索也才 300 元/月。真正的门槛是:开超额要绑定支付方式(一次性动作),以及↓

**合规决策点(提示一次)**:商用软件内置 owner key 服务付费用户,按官方条款属「商业目的」,严格合规要买 ¥5万/年技术服务许可。现实观察:执法以发函催缴为主、主要盯量大的头部产品(二手)。建议:内测/小规模期先用企业认证免费池跑起来,把「高德商业授权」列进正式发售前合规清单(和白标 scrub、知识加密同批 task#22/#23 节奏),届时按用户量决定买授权还是换自建 POI 方案。

### 4.3 落地清单(供排期参考)

1. owner 在 console.amap.com 完成**企业认证**(搜索桶 5千→5万/月,一次性动作)+ 建应用拿 Web 服务 Key,key 存服务器 gw.env;
2. qfgw 加 `/relay/amap-mcp` 路由:反代 `mcp.amap.com/mcp` 并注入 key,验 app 令牌,对搜索/天气按用户限速;
3. 内核 MCP 配置内置这条网关地址为默认 server(领域无关,通用能力,不挂台球包也可用);
4. 前端白标:工具名按现有 toolMeta 大白话化(「查周边」「查路线」「查天气」),不露"高德/amap"字样按白标铁律定夺——**注意**:高德服务协议一般要求展示数据来源,白标掉"高德"字样可能又踩条款,这点在做 scrub 时一并评估;
5. BYOK 高级档:设置里留"自己的高德 Key"输入位,填了则网关透传用户 key。

---

## 五、来源清单

**官方(lbs.amap.com / npm 官方包)**:
- MCP 概述+工具清单:lbs.amap.com/api/mcp-server 、 /api/mcp-server/summary
- 快速接入(Streamable HTTP + npx 配置原文):lbs.amap.com/api/mcp-server/gettingstarted
- 创建应用和 Key:lbs.amap.com/api/mcp-server/create-project-and-key
- 定价与免费配额:lbs.amap.com/upgrade
- 流量限制入口(QPS 看控制台):lbs.amap.com/api/webservice/guide/tools/flowlevel
- 商用服务条款:lbs.amap.com/pages/authorization/ ;服务协议:lbs.amap.com/pages/terms/
- 个人vs企业 FAQ:lbs.amap.com/faq/account/certification/39670
- npm `@amap/amap-maps-mcp-server`(registry 元数据:阿里邮箱维护者、0.0.8、2026-03 更新)

**一手实测(本机)**:
- `curl https://mcp.amap.com/sse` 与 `/mcp`(无 key、假 key)→ 均返回 `{"status":"0","info":"INVALID_USER_KEY","infocode":"10001"}`,证实两端点存在且强制 key;
- 解包 npm 0.0.8:12 个工具名 + 全部调用 restapi.amap.com v3/v4(配额归属 Web 服务);
- GitHub API 搜索 `amap mcp`:56 仓,star 排序见 §三。

**二手(多源一致才采信)**:
- SSE 地址写法、个人实名=支付宝扫码、超额需手动开通付费、发函催缴商用授权:知乎/CSDN/腾讯云文档/DCloud 社区多篇交叉。

**未找到**:
- 当前个人/企业认证的**具体 QPS 数值**(官方只说控制台可查,公开页无数;网传旧数不引用);
- MCP 专属独立配额政策(判断为不存在,与 Web 服务共池);
- 官方 FAQ 页对个人认证所需材料的完整清单(只有二手教程)。
