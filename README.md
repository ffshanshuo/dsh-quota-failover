# dsh-quota-failover

给 DeepSeek Harness 加上「额度撞墙之后仍然有下文」的能力。

当某个 provider 的请求死于额度墙（`QUOTA` / `ACCOUNT_QUOTA` / 终态 429 / 失效凭据 / 该账号不被允许的模型），
DSH 内核会把这个失败当作**终态**：轮次直接结束，子智能体停在那里，任务断在半截。
本插件在那道终态之前插一手，做两件事之一（由你选）：

| 模式 | 行为 | 是否动模型 |
| --- | --- | --- |
| `notify`（默认，推荐） | 不改路由。把「失败原因 + 已试过哪些路由 + 还有哪些可用 + 下一步怎么做」写进失败智能体的**下一轮**收件箱，并记账 | 不动 |
| `auto` | 从候选路由链里挑一条没试过的，改写下一次请求的路由后重试，轮次继续往下走 | 会动 |

两种模式都不注册工具、不改 `allowedModels`、不写 `AgentDefaultModel`；插件只活在
`agent/request`、`agent/request-error` 两个水流点上。

## 为什么需要它

内核**故意**把额度耗尽当终态（`isTerminalRateLimitError` 命中即 `isRetryableError → false`），
`dsh-llm-retry` 的默认可重试码表里也**没有** `QUOTA` / `ACCOUNT_QUOTA`。
于是「额度用完」= 轮次结束 = 子智能体停在半路 = 你派发的任务没有下文。
本插件在 `agent/request-error` 上接管这类失败，让「撞墙」变成「有交接」。

## 安装

```bash
node install.mjs                # 装进 desktop profile
node install.mjs --profile web  # 别的 profile
node install.mjs --uninstall    # 卸载
```

`install.mjs` 做三件事，重复执行无副作用：

1. 把运行文件复制到 `<profile>/node_modules/dsh-quota-failover`（profile 自己的解析根，不依赖工作区 / pnpm）；
2. 在 profile 的 `dependencies` 里登记 `file:` 依赖，`pnpm install|prune` 不会把它当游离包剪掉；
3. 把包名追加到 `dsh.profile.bundles`，于是它的 patch 层生效、Web 客户端半边被下发，
   插件页里也就有了正式条目（带开关与卸载）。

装完需要宿主**重新组合**一次才会加载：在插件页随便开关一个插件，或者重启 DSH。
（只改 bundle patch 不会触发热重载——DSH 只看有序的 `dsh.profile.bundles` 列表变没变。）

两侧的热更新边界不一样：

- **客户端半边**（`lib/client.js`）：面板 bundle 的 rev 由宿主进程**启动时**计算并写进 boot 清单，
  改完文件后只刷新页面不够——实测宿主不重启时 rev 与内容都不变；宿主重启后普通刷新即可拿到新面板；
- **宿主半边**（`lib/index.js`）改完必须**重启宿主进程**：组合重跑时 ESM 模块仍来自进程内缓存，
  换文件名 / 改 patch 行都不会重新 import。

## 设置面板

`设置 → 额度转移`。面板顶部是**固定标签页**（默认落在「状态」，选择记在浏览器
`localStorage['quota-failover.active-tab']`），标签条与保存条都随滚动吸顶：

| 标签页 | 内容 |
| --- | --- |
| 状态 | 是否已武装、当前模式、版本、`armedAt`、宿主 pid、五项概览（候选路由 / 子智能体白名单 / 模型组合 / 可用性 / 最近事件） |
| 失败后怎么处理 | 总开关；模式二选一；是否把情况告诉 agent；`auto` 模式的候选路由列表；对候选路由的连通性测试 |
| 模型组合 | 跨 provider 组合的生成、搜索、停用、刷新、删除；可用性筛选与类别筛选（见下） |
| 可用性 | 按 provider 勾选测试范围、全量/重测、测试结果与「把可用路由填入候选」 |
| 事件 | 插件自己的记账，带「清空事件」 |

- **保存条固定在标签页下方**：无论停在哪个标签页，改完设置都能直接点「保存 / 恢复默认」，
  结果与状态消息就在旁边；`恢复默认` 需要点两次确认。
- **面板顶部标签页只切换可见性**：所有页签的 DOM 都保留（`display: none`），
  切页不会丢输入、也不会重新发请求。
- **模型组合的名字带 `⚡` 前缀**：这是展示层的标记（`⚡ DeepSeek V4.1 Flash`），
  方便和「设置 → 模型」里的普通模型区分；存储里的名字本身不长前缀，
  前缀也只有一个常量（`COMBO_NAME_PREFIX`），以后要换只需改一处。
- **模型路由可用性**：按 provider 勾选范围后逐条测试，结果按 provider 分组、带最后测试时间，
  agent 也能通过 `route_availability` 工具读到同一份（见下）；
- **模型组合（跨 provider 自动降级）**：把同一模型在不同 provider 上的实现编成一条路由，
  按模型类别一键生成（见下）；

### 模型路由可用性

面板把「哪些 `provider/model` 现在真的能用」当成一份**存活记录**维护，而不是一次性表格：

- **测试范围**默认是 `设置 → 内置插件 → 子智能体` 里的白名单——只测已经授权给 agent 的路由；
  可以按 provider 勾选改范围（「仅白名单 / 全选 / 全不选」三个快捷键）；
- **结果分组**：每个 provider 一段，行内给出 ✓/✗、耗时、失败类型与错误码；区块顶部标注
  **最近一次测试时间**。新结果按 `provider/model` 覆盖，没被测到的旧路由保留，
  所以一次局部测试不会把别的 provider 的记录清空；
- **结果会过期**：记录超过 15 分钟自动标「结果已过期」；每个 provider 组带「重测」按钮，
  不用整轮全量重扫就能更新一个 provider 的结论；
- **运行时观测**：真实请求失败（额度墙/账号不支持/临时故障）会由宿主把该条路由写回同一份结果，
  标记为 `source: "runtime"` 并在面板行首显示「运行时观测」——这比等下一次测试更早，
  也解释了「面板刚显示 ✓，实际调用却报额度墙」；顶层 `observedAt` 记录最近一次运行时观测时间；
- **持久化**：结果写 `~/.dsh/quota-failover-probe.json`（宿主侧，重启后仍在），
  同时镜像一份到浏览器 `localStorage`，作为旧版宿主（没有该端点）时的兜底；
- **agent 可读**：宿主注册了 `route_availability` 工具，返回同一份报告（按 provider 分组、
  带最后测试时间、运行时观测与失败原因）；它**只读**已保存的结果，不会自己发请求；
- 「把可用路由填入候选」只填 ✓ 的路由，仍需点「保存」才写盘。

范围是怎么来的：宿主注册表（`GET /_quota-failover/routes`，`llm.listProviders()` +
`llm.listModels(provider)` 枚举）优先；旧版宿主没有这个端点时，回退到客户端 RPC
`remote.session.modelCatalog()`（模型选择器用的同一份目录），所以面板本身**不需要重启宿主**。

白名单优先从客户端的设置表单直接读（`ctx.configForms.get('subagent-model-selection-settings')`，
即子智能体设置卡片正在编辑的那份，还会订阅它的变化），所以**宿主没重启时默认范围也是白名单**；
只有设置通道不可用时才回退到 `GET /_quota-failover/allowlist`（新版宿主）或全部可路由 provider。

每条路由最多等 15 秒；新版宿主用 3 个 worker 并发扫并回报进度。一次选择超过 **200** 条时面板会
**自动分批**：每批 200 条作为一个宿主作业连续跑，跑完再合并结果（进度显示「第 k/n 批」），
所以全量扫描不会因为单次上限被截断；旧版宿主由面板按 4 条一批驱动。

两条注意：

- 测试会真实消耗少量额度；
- 探测只证明「这条 provider/model 能出字」，**不证明模型名拼对了**——适配器接受未登记的 model id，
  所以 `workbuddy/随便瞎写的名字` 也可能回 ok。发现路由是否可用要结合宿主日志与真实调用。

### 模型组合（跨 provider 自动降级）

同一个模型往往有好几家在服务（`workbuddy/deepseek-v4.1-flash`、`trae/DeepSeek-V4-Flash`、
`lobsterai/deepseek-v4.1-flash`……）。额度是**按 provider 算**的，所以一家撞墙时另一家通常还能用。
面板把这些「同名模型的不同来源」编成一条路由：

- 模型 id 形如 `failover-combos/combo:<类别>`，例如 `failover-combos/combo:deepseek-v4-1-flash`；
- 生成方式：面板按 `provider/model` 的最后一段（大小写、`.`/`_`、`sn-` 前缀、`-free` 后缀都归一）
  把同名模型归成**类别**，只列出跨 2 个以上 provider 的类别；勾选后点「按勾选的类别生成组合」；
  成员顺序默认按 provider 数量排序，可用「刷新成员」按最新模型清单重建；
- **名字前缀**：面板里组合名显示为 `⚡ <类别名>`（例如 `⚡ DeepSeek V4.1 Flash`），
  只是展示标记，方便和「设置 → 模型」里的普通模型区分；存储里仍是原名字，
  前缀只有一个常量（`combo/combos.js` 的 `COMBO_NAME_PREFIX`），以后要改只动这一处。
- **组合多时**：列表默认只渲染前 50 个；搜索框按组合名 / 组合 id / 成员过滤，搜索词变化会回到 50 个；
  底部「显示全部 N 个」一次展开。
- **筛选**：「可以生成的模型类别」区可以按 provider 勾选来源（多个 provider 取并集，点「全部」清空筛选），
  还有两个开关：「只使用白名单来源」默认开启——列表只显示白名单能凑出的类别，生成时成员也**只取白名单里的路由**
  （同一模型在别家未授权的实现不会进来）；「显示单来源类别」默认关闭——打开后只有一个 provider 的类别也会列出并允许生成，
  此时组合只有 1 个成员（等于把那条路由包一层，方便统一管理、加入候选链）；
- **生成范围可选**：类别行同时显示「目录 N 条 / M 个 provider」与「白名单 K 条」。
  「全选」勾选当前筛选下的全部类别（成员来自目录）；「按白名单全选」只勾选**白名单本身**就能凑出组合的类别
  （成员**只取白名单里的路由**），生成的组合会标成「仅白名单」，之后「刷新成员」也按它自己的范围重建；
- **可用性筛选**：类别列表与已生成的组合列表共用一排筛选标签——「目前可用 / 上次可用·已过期 /
  目前不可用 / 上次不可用·已过期 / 未测」，可多选（一条组合只要**任意一个成员**命中勾选状态就保留），
  默认不筛。状态取自下面「模型路由可用性」的测试结果（含运行时补记）：15 分钟内的 ✓ 算「目前可用」，
  15 分钟内的 ✗ 算「目前不可用」，更早的分别归入两个「已过期」标签，没测过的算「未测」。
- **降级语义**：一次生成内部逐成员尝试。额度墙、账号不支持该模型、临时故障（`RATE_LIMIT` /
  5xx / 传输错误 / `NO_ADAPTER` 等）会**静默换下一个成员**；正文一旦开始输出（`text-delta` 或
  `tool-call-delta`）就不再回退——已经吐出的字不会撤回。思考增量不算提交。
- 全部成员都失败时报一条链式错误（含每个成员的失败码），并记一笔 `combo-exhausted` 事件。
- 组合作为一种普通模型出现在 `设置 → 模型`（provider 显示为「额度转移 Combo」），
  也可以填进上面的候选链或子智能体白名单，让 agent 显式选它。
- 已生成的组合列表**默认折叠**，点「展开」查看成员与逐条操作。「删除全部」需要**点两次**（第一次变成
  「确认删除全部（N）」，第二次才真删），避免误删；单条「删除」同样要点两次（第一次变成「确认删除」）。
- 组合数量**没有硬上限**：`MAX_COMBOS = 40` 只是面板的舒适提示，超过后提示整理，但不会拒绝新建、
  也不会截断配置文件。

组合配置落在 `~/.dsh/quota-failover-combos.json`（面板的「删除 / 停用 / 刷新成员」都写这份），
宿主把它注册成独立 provider `failover-combos`，因此不依赖 `our-free-model` 那条 combo 链，
也不占用它。注意它只负责**一次生成内部**的降级，不改变 agent 自己选模型的逻辑。

组合 provider、`/combos` 端点与面板卡片都属于宿主半边的新代码，**重启宿主进程后**才出现；
未重启前面板会显示「宿主还没重启：组合功能需要 0.3.0 的宿主代码」。

写盘即时生效，不需要重启。配置落在 `~/.dsh/quota-failover.config.json`，
事件落在 `~/.dsh/quota-failover.json`（最多 64 条，含 `failover` / `notify` / `exhausted` / `expired`，
`notify` 事件带 `delegatorFound` / `delegatorNotified` 两个字段）。

## 失败之后谁知道

模型路由失败时的知情范围是两方，各拿一份不同的说明：

| 谁 | 通道 | 为什么 |
| --- | --- | --- |
| 失败的子智能体 | `session.append('user/message', …, {surfaceOp:'append'})` 写进它的会话历史 | 它这一轮已终止，收件箱投递会被丢弃（实测 `outcome: "canceled"`）；写历史既留下痕迹又不唤醒任何东西 |
| **派发它的父 agent** | `agent.inject({content, source})`，落在下一个被接纳的 step | 父 agent 通常还在跑（正等这个子智能体），`inject` 不唤醒、不开新轮，但**它才是选模型的那一方** |

给父 agent 的说明要求它先判断任务是否依赖原模型的特有能力（视频 / 图像 / 长上下文 / 特定工具），
再决定换哪个模型或改派任务——插件自己不做这个判断，因为它不知道任务的模态需求。
`auto` 模式同样会告诉父 agent「你的子会话被自动换成了 X」，因为那次切换对调用方本来是不可见的。

## 什么时候它会动

- **额度墙**：`QUOTA`、`ACCOUNT_QUOTA`、`INSUFFICIENT_QUOTA`、`BILLING`、`PAYMENT_REQUIRED`、
  `MISSING_CREDENTIAL`、`AUTH`，以及文案命中「余额 / 额度 / 欠费 / quota / balance / billing」的错误。
  这类失败**不会**被 `dsh-llm-retry` 重试，所以本插件抢在它前面接管。
- **软失败**：`RATE_LIMIT`、`SERVER`、`TIMEOUT`、`TRANSPORT`、`EMPTY_RESPONSE`、`STREAM_CUT`、
  `NO_ADAPTER`、`MODEL_NOT_FOUND`、`NOT_FOUND`、`UNAVAILABLE`，以及**路由级拒绝**文案
  （`model [x] is not allowed`、`该模型`、`账号类型`……）。这类只在 provider 自己的重试策略放弃之后才接管。
- 不动的东西：工具报错、middleware 报错、上下文超限——那些不是路由问题。

## 配置行

```yaml
- id: dsh-quota-failover
  config:
    enabled: true
    mode: notify            # notify | auto
    candidates:             # auto 模式的路由阶梯，按顺序
      - workbuddy/deepseek-v4.1-flash
      - lobsterai/deepseek-flash
      - minimax/MiniMax-M3
      - deepseek-official/deepseek-flash
      - our-free-model/combo:free-ladder
    stickyMs: 1800000       # 换路后粘多久（毫秒），0 = 不粘
    journal: true
    maxSessions: 512
```

`candidates` 也接受 `{ provider, model }` 对象。`auto` 模式默认 `respectAllowlist: true`：
当子智能体模型白名单开着时，只在白名单内的路由里挑，不会偷偷跳到没授权的模型上。

## 组合成员诊断

设置 → 额度转移 → 模型组合 的每张组合卡都有一个「诊断」按钮。它调用
`POST /_quota-failover/combos` 的 `action: "diagnose"`，逐个向宿主解析组合成员并返回：

- 每个成员是否可解析（`resolved`）以及宿主给出的错误（最多 300 字符）；
- 每个成员实际公布的推理档位（`reasoning.efforts`，含默认档）；
- 摘要：成员总数、可解析数、有推理档位数，以及所有有档位成员的公共档位交集。

诊断是只读的：不改组合文件、不写缓存、不触发重载；单成员失败不会中断其他成员，整体最多等待
约 6 秒。`resolved: true` 且 `reasoning: null` 只表示该路由没有公布思考档位，不是错误。

## 已知边界

- `notify` 模式下轮次仍然是终态——说明是为了让**下一个接手的人**（Lead 的下一条消息、
  teammate 的下一个任务、你的追加指令）知道发生了什么，而不是让这一轮自己复活。
- 被销毁的智能体（例如 workflow 子智能体跑完即销毁）收不到说明：队列随它一起消失。
  这条说明对 durable 的 teammate 和主会话有效。
- `auto` 模式可能跳到没被授予给子智能体的模型上，也可能跳到能力不匹配的模型上（例如视觉任务落到纯文本模型）。
- 切换动作对模型本身不可见（内核原生切模型会插一条 `[model changed: …]`，本插件只写记账 + 收件箱说明）。
- 可用性记录是**快照 + 运行时补记**，不是实时状态：超过 15 分钟会标「已过期」，真实调用失败会写一条
  `source: "runtime"` 的观测；但路由仍可能在此之间挂掉或恢复，agent 用它时要结合时间判断可信度，
  需要更新就让用户在面板里按 provider「重测」。
- `route_availability` 工具、`/allowlist` 与 `/probe/results` 端点属于宿主半边的新代码，
  **重启宿主进程后**才出现；旧宿主上面板照常工作：白名单从客户端设置表单读，结果先存浏览器
  `localStorage`，重启后自动以宿主的那份为准。
- 面板 HTTP 路由是在 `ctx.inject(['webServer'], …)` 的独立 fiber 里注册的，不是 apply 时
  `ctx.get('webServer')` 一次取值。宿主组合里插件通常**先于**浏览器半边发布 `webServer` 加载，
  一次取值会拿到 `undefined`，路由静默丢失——面板于是永远停在「正在读取插件状态…」。
  修法同 `dsh-our-free-model` 的注释所述：inject 会等（且服务被替换时重跑）。
- 组合成员只能是**当前宿主目录里存在**的模型：某家下线后该成员会被跳过（面板「刷新成员」按最新清单重建）；
  组合公布的上下文窗口、最大输出、视觉取成员交集；推理强度按下一段的规则公布。
- 组合的**推理强度**：`LlmRuntime` 会用 `resolveModelInfo` 把组合公布成「有推理档位成员的交集」，
  没有档位或暂时解析不到路由的成员不参与公布；只要至少一个成员声明了档位，设置 → 模型 / 会话模型
  选择器里就能为组合挑档位，默认档也来自交集。b13 起用户选中的档位会真正下发给**声明了该档位**的
  成员；某个成员没有这个档位（或根本不推理）时，它会退回自己的默认档，而不是让整个请求失败——所以
  一条组合里不同成员实际用的档位可能不同。
- 组合的降级只发生在**一次生成内部**：正文已开始输出后失败不会换成员；换成员对模型自身不可见，
  也不会写 `[model changed]` 这类会话提示。
- 成员分派必须原样带回 `prepareCall` 解析出的路由字段（provider / model / reasoningEffort /
  temperature / maxTokens / stop）。内核会核对这六项，任何一项被事后改写就报
  `INVALID_PREPARED_CALL: prepared LLM call config changed before adapter dispatch`——典型是成员模型
  自带默认推理强度或最大输出上限、而调用方又传了不同的值。b12 起组合改为「先按最终路由提议、再用
  `call.config` 组装分派参数」，并把该错误码当作可越过失败（单个成员配置不兼容不再拖垮整条链）。

## 文件

| 路径 | 作用 |
| --- | --- |
| `lib/index.js` | 宿主半边：两个水流点监听、记账、HTTP 路由、combo provider 注册 |
| `lib/client.js` | 浏览器半边：`设置 → 额度转移` 面板 |
| `lib/combo/` | 跨 provider 组合：`classify.js` 分类、`combos.js` 配置与链、`catalog.js` 容量交集、`adapter.js` 流式降级 |
| `cordis.patch.yml` | 把插件行插进 profile 组合 |
| `install.mjs` | 自安装 / 自卸载 |
| `~/.dsh/quota-failover.json` | 事件记账（含 `armedAt`，是「插件活着」的证据） |
| `~/.dsh/quota-failover.config.json` | 面板写入的配置 |
| `~/.dsh/quota-failover-probe.json` | 可用性测试结果（面板与 `route_availability` 工具共读，含每条路由的 `at`） |
| `~/.dsh/quota-failover-combos.json` | 跨 provider 组合的定义（面板卡片读写） |

## 从 GitHub 安装（公开仓库）

仓库：<https://github.com/ffshanshuo/dsh-quota-failover>

```bash
git clone https://github.com/ffshanshuo/dsh-quota-failover.git
cd dsh-quota-failover
node install.mjs                 # 装进 desktop profile
node install.mjs --profile web   # 装进别的 profile
node install.mjs --uninstall     # 卸载
```

`install.mjs` 会把运行文件复制进 `<profile>/node_modules/dsh-quota-failover`，
并把该 profile 的 bundle patch 行写成相对路径 `./lib/index.js`。DSH 会把插入的
相对插件路径锚定在 patch 文件旁边，所以这一行在任何机器 / 用户名下都解析到包内
的 `lib/index.js`，即使 pnpm 之后重新物化这个包也不会失效。
装完需要宿主重新组合一次：在插件页随便开关一个插件，或重启 DSH（只改 patch
文件不会触发，必须让 `dsh.profile.bundles` 列表发生变化）。

## License

MIT — 见 [LICENSE](LICENSE)。
