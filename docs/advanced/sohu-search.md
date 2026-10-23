# 搜狐号账号检索与公开检索

当前版本：2.1.77-sohu.20261022。两个命令默认返回平台候选和证据，由调用 Agent 判断相关性。标题不包含整个关键词、没有高亮、公开结果类型未知，不再导致整批检索失败。

## 命令用法

```bash
# 自己账号的候选，支持 all/article/video/gallery 和 published/all/draft
bycli sohu search "大脑" --type video --status published -f json
bycli sohu search "影子" --type article --status draft -f json
bycli sohu search "咖啡" --type gallery -f json

# 可选账号一致性保护，不是查任意其他作者
bycli sohu search "关键词" --account-id 123034857 -f json

# 全站公开候选；可能包含平台回退推荐
bycli sohu search-public "人工智能" --limit 15 -f json

# 显式要求完整标题相等，不区分大小写；不是子串匹配
bycli sohu search "我的大脑，卡在了99%" --exact-title -f json
bycli sohu search-public "我的大脑，卡在了99%" --exact-title --limit 1 -f json
```

关键词为1–100个字符、单行。两条命令均只读，不发布、不保存草稿、不丢弃编辑内容。页面存在保留编辑器时仍保留编辑器并报告占用，使用`bycli sohu editor`查看。

## 结果和判断职责

结果信封中的`results`是平台候选，不保证每条都是用户任务的目标作品。每条包括：

- `content_id`、`title`、`url`、作者或账号身份、`platform_type`。
- `match.title_contains_keyword`：标题是否包含完整关键词，不区分大小写。
- `match.title_equals_keyword`：标题是否与完整关键词相等，不区分大小写。
- `match.query_highlighted`：公开模型是否有与查询词对应的标题或摘要高亮；后台没有该证据时为null。
- `match.recommendation`：观测到已知无高亮回退路线时为`observed_fallback`，其余为`unconfirmed`。不是凭type枚举推断推荐。
- `warnings`：如`UNKNOWN_PLATFORM_TYPE`、`QUERY_RELEVANCE_UNCONFIRMED`、`VISIBLE_CARD_UNVERIFIED`，保留结果供Agent继续检查。

公开结果还包含`verification.source_identity`和`verification.visible_card`。可信内容链接、内容ID和作者ID必须相符；单条无法验证的身份或外域链接会跳过，信封中记录`skipped_invalid`和带索引的告警，不影响其余有效条目。源链接移除跟踪参数，不输出Cookie、passport或原始响应全文。

公开未知类型保留`platform_type`，`content_type=unknown`，不报`PUBLIC_RESULT_TYPE_UNSUPPORTED`。已知枚举也不据此推断视频：`/a/<id>_<author>`保留`article_or_video`，`/picture/<id>`识别为gallery。下载前由Agent核对目标标题、作者、ID或打开详情。

默认保留疑似推荐：`excluded_recommendations=0`，`observed_recommendations`统计已加载候选中的已观测回退数量。它可能大于返回数量，因为limit只裁剪输出。明确注入卡片仍不计为内容候选，记录`excluded_injected`。不会将仅推荐的一批结果误判为全部搜索结束。

## 账号后台入口和分页

真实入口：`https://mp.sohu.com/mpfe/v4/contentManagement/first/page`。
页面GET端点：`/mpbp/bp/news/v4/users/news`。

| 条件 | 页面实际参数 | 返回记录 |
|---|---|---|
| 全部类型 | newsType=0 | data.news，逐条区分类型 |
| 文章 | newsType=1 | data.news，type=2 |
| 图集 | newsType=3 | data.albums，type=3 |
| 视频 | newsType=4 | data.videos，type=4 |
| 全部状态 | statusType=1 | 已发布、草稿等 |
| 已发布 | statusType=2 | status=4 |
| 草稿 | statusType=6 | status=1 |
| 关键词 | titleKeyword | 平台可能按分词扩大召回 |
| 分页 | pno、psize=10 | 通过真实下一页按钮前进 |

默认type=all、status=published。执行前后核对当前账号，逐条userId也必须属于该账号。请求必须对应关键词、账号、类型、状态和页码，并与页面可见记录核对；身份和请求来源校验不因相关性放宽而取消。

`--page`为1–50，表示平台候选页，每页10条。`--limit`为1–10，裁剪该页输出。`has_next_page`指还有候选页，`remaining_on_page`指本页被limit裁剪的候选，`has_more`涵盖两者。

默认`total`为平台候选总数，`backend_total`保留同一来源；缺失则为null。启用`--exact-title`后，仅在第一页已完整覆盖候选集时计算精确总数，否则`total=null`。`candidates_on_page`和`excluded_nonmatching`说明显式过滤情况。精确过滤后某页为空不代表没有后续候选页。

草稿不返回公开URL；`post_time`保留平台毫秒值，不把草稿时间称作发布时间。后台未知内容类型标为other并附警告。

## 公开入口和不完整结果

真实入口：`https://search.sohu.com/?keyword=…`的综合标签。使用独立临时查询页。页面通过`https://odin.sohu.com/odin/api/search/blockdata`加载，命令只操作正常页面及滚动，不构造该POST请求。

`--limit`为1–50，默认10。只读取`#news-list`关联模型及卡片，覆盖带封面标题`.cards-content-title a`和纯文本`h4 a`；不读取侧栏热搜、账号推荐和作者专栏。没有已验证的独立公开文章/视频/图集筛选参数。

首次加载无法确认搜索词或模型时仍明确报错，不返回成功空列表。取得候选后，滚动失败或后续模型不可确认时返回已取得结果，`partial=true`、`stop_reason=scroll_failed`并附错误码；滚动无进展或达到7次追加边界也返回partial说明。可见卡片未核对或跳过无效记录也使partial=true。

`total`始终为null，公开平台总数不可靠。`has_more`基于实际模型结束状态和被limit裁剪的候选，不保证剩余候选相关。`--exact-title`过滤发生在本次已加载候选上，不保证穷尽整个索引。

## 验证和历史纠正

2.1.75曾误把type=2当作推荐；真实复验表明type=1/2/4都可以是命中。2.1.76修正了type=4和带封面结构，但仍用高亮判定作为必需条件。2.1.77取消相关性硬拦截，默认返回平台候选与证据。

站点不是稳定开放API，首次搜索上下文无法确认、账号变化、后台响应归属错误等仍需停止。真实账号内容少，后台两页翻页和异常结构由本地夹具覆盖，不冒充真实多页验收。

回归命令：

```bash
npx vitest run --project adapter clis/sohu clis/_shared/video-stats.test.js clis/_shared/video-submit.test.js --project unit src/execution.test.ts src/commanderAdapter.test.ts
npm run build
```

## 2.1.77 本轮验收

- 完整标题“我的大脑，卡在了99%”：账号默认3条候选（标题证据一真两假），--exact-title返回目标1089674669一条；公开默认10条相关候选，--exact-title --limit 1返回同一目标。
- 随机无匹配词：公开保留10条平台候选，逐条match.recommendation=observed_fallback，excluded_recommendations=0。returned表示候选数量，不等于已确认命中数量。
- 真实首次查询发现类型切换完成后可能重置状态，已加入所选状态稳定等待和本地回归，避免误查全部状态。
- 本轮检索92项测试通过；连同搜狐及相关执行层共16文件445项通过。覆盖未知类型、无高亮、单条无效身份、可见卡片未验证、精确标题筛选、后续滚动/模型失败保留候选。
- 真实复验仅查询，关闭本次使用的页面，不停止托管daemon或Chromium。
