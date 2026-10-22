# Weixin Channels（微信视频号助手）

发布前必须先保存、重开核对平台草稿，向用户展示具体内容并获得明确确认；然后单独调用 `--mode submit --execute --user-confirmed`。准备阶段不得预先传入确认参数。详见[三平台发布确认流程](../../guide/publishing-confirmation.md)。

`video-publish --timeout` 是整次浏览器操作的总预算，上传、两张封面、保存和重开核对共用同一个截止时间。原生按钮响应连续 5 秒、草稿回执或页面加载连续 30 秒、上传/处理或封面预览连续 60 秒没有可观察进展时提前停止。进度条前进或新的业务状态才算进展；轮询次数、重复状态及签名 URL 刷新不延长等待。没有暴露进度不等于平台处理失败，超时保留为未确认状态，不能自动重复上传、保存或发表。

阶段变化及每 15 秒的进度写入 stderr，stdout 保持最终 JSON。浏览器调用本身尚未返回时，心跳只报告最后已知状态；调用取消仍由 Browser Bridge 和外层进程预算处理，不并发探测页面。operation 中的 `wait`、`wait_error` 保存阶段、无进展时长与诊断，`video-status --operation` 可本地读取。核对失败会撤销旧的已核对标记，只有重新核对成功才恢复可提交状态。

本地视频预览可播放时，平台仍可能在生成默认封面、暂时禁用“保存草稿”。Adapter 在同一总预算内等待原生保存按钮启用，连续 60 秒无进展则保留上传结果并停止；等待期间不点击保存、不重传。原草稿身份、描述或 AI 标注变化时立即拒绝保存。

封面编辑弹窗自身也有视频初始化和图片绑定过程。Adapter 只读观察其初始化与裁剪器状态：初始化完成后才上传封面，裁剪器已绑定当前上传图片后才确认，防止迟到的视频首帧刷新覆盖图片。若原页在确认后明确记录 `imgSizeInvalid width=0 height=0`，且该角色、缩略图、两张卡片及原草稿均匹配，可自动取消失败弹窗并重新配置该角色一次；未知错误、旧日志、卡片变化或已尝试保存均不允许重试。对于保留的旧失败操作，可用 `--mode resume --retry-cover-processing horizontal|vertical` 明确进入同一记录的处理失败恢复；不重新上传视频，不重置原确认和保存历史。

封面“确定/确认”默认自动执行：先滚动、聚焦并等待按钮位置稳定，核对唯一可见控件、预览和命中区域，再使用 `nativeClickOnce` 发送浏览器鼠标输入，不依赖 DOM `.click()`。单次预留使用 `evaluateOnce`，鼠标事件使用无传输重试的通道；结果未知时不补发第二次点击。operation 的 `cover.activation` 区分准备、预留、输入已发出、响应未知及卡片已核验，只有弹窗关闭且对应卡片变化才算确认完成。人工确认不是正常步骤。若旧记录在 `confirm_unknown`，用户明确手动确认了横/竖封面后，才可对原 operation 执行 `--mode resume --cover-confirmed horizontal|vertical`。恢复先在原页核对草稿 ID、描述、AI 标注、该卡片变化及另一卡片未变，再继续尚未配置的封面、保存并重开原草稿；不重新上传视频、不点击已完成封面的确认，不自动发表。

原生保存可能已跳转到草稿箱，旧编辑文档的 Resource Timing 随之消失。跳转只用于读取已有 CDP 捕获；仍须精确 POST 回执的 HTTP 201、errCode 0、时间及草稿 ID 全部匹配，才能确认保存。`video-status --inspect-editor` 可对不确定的封面保存读取已有回执，并只读重开原草稿核对封面；不会重新保存或恢复 AI 标注。没有有效回执或封面不符时保留未知状态，不能把草稿箱页面当作保存成功证明。

浏览器鼠标输入的响应丢失时，Adapter 可只读核对原页：只有对应卡片已变化、另一卡片仍符合记录且弹窗已关闭，才继续尚未配置的封面。对于延迟完成的同类确认，`resume` 先核对原编辑页，不导航丢弃未保存修改；核对成功才继续并保存原草稿。卡片不符、弹窗仍开或结果未知时停止，不重发确认，也不要求人工确认已自动完成的结果。

若原记录停在 `cover.phase=opening`，且尚未选择或上传图片，可用 `--mode resume --resume-cover-opening horizontal|vertical` 核对原草稿、描述、AI 标注、两张卡片和图片哈希后，原地继续未尝试的上传。原编辑页标识已失效时，可同时加 `--reopen-saved-draft`，按原草稿 ID 与描述重开并核对默认两张卡片后再配置；此重开入口要求两角色均未上传、确认或保存。未知上传/确认、已尝试保存或卡片变化均不得借此重试，已完成的封面也不会重复配置；不能新建 operation 或清理 Gate 规避历史。

**Mode**: 🔐 Browser · **Domain**: `channels.weixin.qq.com`

这组只读命令通过当前视频号助手登录会话查询账号统计和作品数据。先在 Chrome 中打开[视频号助手](https://channels.weixin.qq.com/)并扫码登录目标视频号，确保 byCLI 的 [Browser Bridge](/guide/browser-bridge) 已连接。公众号后台的登录状态不能代替视频号助手登录。

## 命令

| 命令 | 用途 | 默认日期窗口 |
| --- | --- | --- |
| `bycli weixin-channels overview` | 账号指标概览，返回一行 | 昨日 |
| `bycli weixin-channels trend` | 账号逐日指标，按日期排列 | 最近 7 天 |
| `bycli weixin-channels sources` | 按后台来源标签汇总账号指标及播放占比 | 最近 7 天 |
| `bycli weixin-channels posts` | 按发布时间筛选作品，返回作品累计指标 | 最近 30 天 |
| `bycli weixin-channels post-detail <id>` | 单篇作品概览、趋势、来源占比、逐日来源明细和留存，返回一行 | 最近 7 天 |
| `bycli weixin-channels video-stats <id>` | 单条视频当前累计播放、推荐、喜欢、评论、分享；缺失的收藏明确标注 | 当前累计，不受日统计结算窗口限制 |

前五个命令的默认窗口截至 **Asia/Shanghai 的昨日**；`video-stats` 读取当前累计值，包括今天已发表的作品。命令读取当前登录账号，不接受 Cookie 或签名参数。

### 单条视频累计指标

```bash
# 数字统计 ID：今天的新作品也可按精确身份查询，无需发布操作记录
bycli weixin-channels video-stats 15035867620425145936 -f json

# 或管理页返回的完整 export/... ID；二者属于不同 ID 域，不能直接转换
bycli weixin-channels video-stats 'export/<完整管理 ID>' -f json
```

返回 `id`、`id_type`、`title`、`published_at`、`plays`、`recommendations`、`likes`、`comments`、`shares`、`collections`、`unavailable_metrics`、`sampled_at`。`plays` 与原命令的 `views` 同为播放次数；`recommendations` 为推荐/赞，`likes` 为喜欢，沿用原字段口径。数值为当前累计，并非所选日期的增量。数字 ID 查询复用原统计列表接口，管理 ID 查询复用管理列表，精确匹配本人作品，不依赖本地 operation 文件。

当前真实后台的页面、响应和已加载统计代码均未找到独立收藏计数字段，因此 `collections=null`，并返回 `unavailable_metrics.collections=not_exposed_by_verified_backend`；不是零，也不以“喜欢”替代收藏。其他后台缺失计数同样为 null，原因是 `not_returned`。该输出说明数据源的实际能力，不代表收藏采集已实现。作品不存在、身份不符、接口错误或分页不完整均报错。

## 使用示例

```bash
# 昨日账号概览
bycli weixin-channels overview --format json

# 最近 7 天的账号逐日趋势
bycli weixin-channels trend --days 7 --format json

# 最近 7 天的来源汇总
bycli weixin-channels sources --days 7 --format json

# 最近 30 天发布的作品，最多 20 条
bycli weixin-channels posts --days 30 --limit 20 --format json

# 将 posts 返回的完整 id 填入这里，再查询这篇作品
bycli weixin-channels post-detail '<id>' --days 7 --format json
```

`id` 是作品的 `objectId`，始终是数字字符串。复制时保留完整数字；它可能超过 JavaScript 的安全整数范围，不能先转成数值再传入。

五个命令都支持成对的自定义日期，起止日均包含：

```bash
bycli weixin-channels overview \
  --start-date 2026-10-01 --end-date 2026-10-07 --format json

bycli weixin-channels posts \
  --start-date 2026-09-01 --end-date 2026-09-30 --limit 50 --format json

bycli weixin-channels post-detail '<id>' \
  --start-date 2026-10-01 --end-date 2026-10-07 --format json
```

`--days` 与 `--start-date` / `--end-date` 互斥。日期格式必须为 `YYYY-MM-DD`，起日不能晚于止日，止日最晚为上海昨日；单次窗口最多 366 天。`--days` 必须是 1–366 的整数，`posts --limit` 必须是 1–1000 的整数。这些选项均须提供值，裸 `--days`、`--limit` 或日期选项会报告参数错误。

## 输出与指标口径

推荐使用 `--format json`（或 `-f json`），尤其是 `post-detail`：JSON 保留嵌套的概览、趋势、来源和留存，以及未列入表格的作品字段。

| 输出字段 | 含义 | 后台字段 |
| --- | --- | --- |
| `views` | 播放次数 | `browse` / `readCount` |
| `recommendations` | 推荐次数 | `like` / `likeCount` |
| `likes` | 喜欢次数 | `fav` / `favCount` |
| `comments` | 评论次数 | `comment` / `commentCount` |
| `shares` | 后台的分享汇总次数 | `forwardAggregation` / `forwardAggregationCount` |
| `follows` | 每日统计为净新增关注；作品列表为后台累计关注指标 | `follow` / `followCount` |
| `completion_rate` | 完播率，单位为百分数，例如 `1.95` 表示 1.95% | `fullPlayRate` × 100 |
| `avg_play_seconds` | 平均播放时长，单位为秒 | `avgPlayTimeSec` |
| `views_pct` | 来源播放占所选周期总播放的百分比，例如 `64.29` 表示 64.29% | 来源 `browse` 之和 ÷ `totalData.browse` 之和 × 100 |

`shares` 使用后台提供的分享汇总，包含其统计的分享渠道；不能把它当作仅“转发给朋友”的 `forward`，也不能把汇总值再与各分享渠道相加。推荐和喜欢是两个不同指标，分别保留。

账号和单篇作品的每日统计中，推荐、喜欢、评论、关注按后台的**净变化**口径计算，扣除取消推荐、取消喜欢、删除评论和取消关注。因此某一天或所选周期的汇总可能出现负数；命令保留这些值。`posts` 返回的作品字段仍是后台提供的累计指标。

计数 `0` 表示后台明确给出零；`null` 表示未提供该指标。空数组、缺失值和不支持的指标不会被补成零。鉴权、请求或数据结构异常会报告错误，不会生成一组成功的零计数。

`overview` 返回 `start_date`、`end_date` 和上述六项计数，是所选日期的**每日统计之和**；`trend` 返回 `date` 和逐日计数。`sources` 使用后台返回的来源名称和 ID，不根据名称合并来源；JSON 中保留 `source_id`、`start_date` 和 `end_date`。

`sources` 的 `views_pct` 保留两位小数，分母是账号或作品的后台总播放次数，不使用已返回来源播放次数之和代替。总播放为零或缺失、该来源播放缺失时返回 `null`；总播放大于零且该来源播放明确为零时返回 `0`。各来源独立舍入后占比之和可能不恰好等于 100。

`posts` 的日期只用于筛选**作品发布时间**，作品计数是后台返回的**累计指标**，不会因为指定了日期窗口就变成该窗口内的增量。因此作品列表计数之和不应直接与账号 `overview` 对账。没有符合发布时间条件的作品时，JSON 返回 `[]`。

实际列表服务可能忽略请求中的发布时间范围，当前实现会再次按每条 `createTime` 本地过滤；`--limit` 计符合日期条件的作品数，必要时继续扫描后续页面，最多扫描 100 页。不会把今天作品混入截至昨日的列表；今日作品的累计数据使用 `video-stats`。

`post-detail` 返回一个包含以下字段的对象：

| 字段 | 内容 |
| --- | --- |
| `id`、`start_date`、`end_date` | 原样保留的作品 ID 和统计窗口 |
| `overview` | 该作品在所选统计周期内的指标汇总 |
| `trend` | 该作品在所选统计周期内的逐日指标 |
| `sources` | 该作品在所选统计周期内的来源汇总及 `views_pct` |
| `data_details` | 逐日来源明细，按日期升序排列；每行含 `date`、`source_id`、`source` 和六项计数，同日按后台来源顺序排列 |
| `retention` | `video_seconds`、`max_loss_second` 和 `points`；每个点含 `second` 与百分数 `retained_pct` |
| `fans_breakdown_available` | 后台是否提供可用的粉丝拆分数据 |

留存曲线描述作品播放进度上的留存，`second` 为播放到的秒数；它不是日历日期序列。

`data_details` 保留各来源的每日数据，`trend` 是全部来源的每日统计，二者不能相加。不存在来源时明细返回 `[]`；来源存在但某项指标未提供时保留 `null`。同名但 ID 不同的来源保持独立，净变化指标中的负数原样保留。

## Agent / 技能接入

调用方先用 `bycli list -f json` 动态发现 `weixin-channels`，再查看相应命令的 `--help`；采集命令使用 `-f json`。浏览器桥接按调用方技能的统一入口预检，适配器自行管理 TAB，无需预先运行 raw browser 命令。

`weixin-channels` 是视频号命名空间，与公众号 `weixin` 分开。共享 `weixin-browser-runner.mjs` 按站点、域和命令权限检查能力，不能将视频号命令改写成公众号命令。`post-detail` 的结果为对象数组，明细位于第一项的 `data_details`，调用方应完整保存嵌套 JSON。

通过 `knowledge-collection` 归档时，统计 JSON 可作为会话 `raw/` 下的原始证据；正式物化产物仍须符合该技能的 Markdown 与 sanitized 目录契约。统计数据不属于公众号文章全文，不能交给公众号下载 materializer 或标记为 `full-text`。完整归档流程还需要上游提供 Session Root 和合法的采集会话；这里只提供网站执行层的结构化数据。

## 会话与登录

会话凭据从当前浏览器内的后台请求获取，仅保留在命令内存中。Cookie、会话标识和请求签名不写入文件、不出现在结果中。

登录失效时在视频号助手重新扫码，确认当前账号后重试。命令沿用后台允许的访问范围和数据可用性。

## 视频发布与现有采集整合（后台发表与新作品即时采集已实测）

当前流程已在 `2b71e254` 统一为原生保存草稿、按回执 ID 从草稿箱重开核对、等待上层向用户确认，再单独 submit；上一轮自动保存及重开实测通过，本轮不运行验证。下述现场记录保留各自时间点的结论。

视频号下载不在本次范围。原有五个统计命令和字段口径保持不变；新增 `video-publish`、`video-status`，共用 `weixin-channels` 命名空间。

**已有草稿发布实测更新**：2026-10-19 21:04:56，用户手动保存的「本体江湖功能验证」已从草稿箱重新打开，通过 `adopt-draft` 核验及 `submit` 单次提交，平台 `post_create` 返回 HTTP 201 / errCode 0；管理列表稳定由 18 条增加至 19 条，新作品状态为 1，累计指标读取成功。再次 submit 未重复发表。自动上传的封面异常仍保留未通过标签；本次不覆盖自动上传验收。详见 [已有草稿发表验收](../../research/connector-integration-2026-10-19/channels-saved-draft-publication-2026-10-19.md)。

用户手工创建的已有草稿可以先用 `bycli browser <session> bind` 绑定用户页面，从草稿箱按精确卡片 ID 选择“编辑”，再运行：

```bash
# 不上传；核对编辑器的两个草稿对象 ID、描述、视频、封面，必要时恢复明确指定的 AI 标注
bycli weixin-channels video-publish --mode adopt-draft \
  --draft-id 'export/<草稿箱精确 ID>' --description '完整草稿描述' --ai-generated yes \
  --editor-session channels-draft --editor-page '<browser tab list 返回的页面 ID>' \
  --operation ./saved-draft-operation.json --execute --keep-tab true -f json

bycli weixin-channels video-publish --mode submit --user-confirmed \
  --operation ./saved-draft-operation.json --execute --keep-tab true -f json
```

`adopt-draft` 使用独立操作记录，不能覆盖旧记录。手工草稿的初次定位/打开通过通用 `browser` 命令完成；自动 prepare 保存后的精确草稿重开已内置实现，适配器不会仅凭标题猜测草稿。重开后 AI 标注可能被平台清空，按明确参数重新配置后才允许提交；草稿 ID 与发表后新管理 ID 分开保存。操作记录含绑定浏览器会话，后续提交沿用相同 lease；当前这条路径使用 `--trace off`（默认），避免旧版扩展创建旁路 trace 会话时复用已绑定编辑页。相关扩展保护修复已构建，仍需重新加载扩展后才在浏览器生效。

**最新验收边界**：2026-10-19 用户重启浏览器后封面生成恢复，已通过 byCLI 绑定页面流程实际发表一条固定视频，后台列表由 18 条稳定增加到 19 条。整合后的 video-status 按精确管理端 ID 读到该作品累计数据。历史列表、趋势、来源和留存此前已通过；新作品结算后的日统计仍待验证，公开 URL 未验证。重启恢复和最终点击经绑定页面流程完成，不表示 video-publish 已支持自动跨重启恢复。详见 [重启后发表及数据验收](../../research/connector-integration-2026-10-19/weixin-channels-restart-publication-validation-2026-10-19.md)；[首次真实验收](../../research/connector-integration-2026-10-19/weixin-channels-live-validation-2026-10-19.md) 保留此前封面阻塞记录。

发布分成两个独立步骤，必须显式 `--execute`，并一直复用同一个本地操作记录。准备阶段会选择文件、填写描述、设置 AI 标注并等待视频预览元数据；随后点击原生“保存草稿”，按成功回执 ID 从草稿箱重开核对；不会点击发表。当前不自动选择封面、声明原创、接受协议或完成验证，页面要求这些动作时应人工检查。

```bash
# 父目录须先存在；准备后保留原标签页，核对视频、描述、封面和 AI 标注
bycli weixin-channels video-publish ./video.mp4 \
  --description '完整视频描述' --ai-generated yes \
  --operation ./channels-operation.json --execute \
  --keep-tab true --window foreground -f json

# 仅提交上一步已准备且未更换/刷新的标签页
bycli weixin-channels video-publish --mode submit --user-confirmed \
  --operation ./channels-operation.json --execute \
  --keep-tab true --window foreground -f json

# 只读取本地操作记录，不连接浏览器，不会重复发表
bycli weixin-channels video-status --operation ./channels-operation.json -f json

# 只读检查原页，返回视频元数据、描述、AI 标注、封面和按钮状态
bycli weixin-channels video-status --operation ./channels-operation.json \
  --inspect-editor --keep-tab true --window foreground -f json

# 仅对未尝试提交的中断准备恢复编辑；核对原页绑定和预览，不重传文件
bycli weixin-channels video-publish --mode resume \
  --operation ./channels-operation.json --execute --keep-tab true --window foreground -f json

# 用户明确要求重新上传，且原标签页重开后已为空：保留原操作 ID，只重传同哈希文件
bycli weixin-channels video-publish ./video.mp4 --mode retry-upload \
  --operation ./channels-operation.json --execute --keep-tab true --window foreground -f json

# 从现有作品列表取得完整 objectId；当天作品不在默认统计窗口内
bycli weixin-channels posts --days 30 --limit 100 -f json

# 当天新作品：管理页的 export/... ID，读取已发表状态和累计数据
bycli weixin-channels video-status --operation ./channels-operation.json \
  --management-id 'export/<管理页返回的完整 ID>' \
  --site-session ephemeral --keep-tab true --window foreground -f json

# 明确指定 ID，验证当前账号作品的描述和时间，再复用原有单篇采集逻辑
bycli weixin-channels video-status --operation ./channels-operation.json \
  --id '<完整 objectId>' --days 30 --limit 100 -f json
```

`--ai-generated yes/no` 必须按实际填写。`video-publish --timeout` 接受 1–1800 秒，默认 180；`prepare` 为默认模式，`submit` 不重新上传。提交时必须有匹配的页面身份、操作标记、完整描述、视频元数据及 AI 标注；刷新或换页后拒绝提交。

`retry-upload` 不自动触发。它只允许未尝试提交且准备中断的原操作，在仍能识别的原标签页上执行；要求页面没有视频、已选择文件或描述，文件 SHA256 与原记录一致。描述和 AI 选项仍取原记录，并追加 `upload_retries`。有预览时用 `resume`，已尝试提交时只能核对状态；不能以重传覆盖未知提交结果。这不提供浏览器重启后失去标签页身份的自动恢复。

返回 `operation_id`、`status`、`submitted`、`id`、`management_id`、`metrics_source`、`editor_url`、`public_url`、`description`、`ai_generated`、`message`、`metrics`、`analytics` 和 `editor`。`editor_url` 不是公开链接；未取得公开链接时 `public_url=null`，不拼造分享 URL。`submitted=true` 表示已尝试点击，不证明服务器已接受。

`--inspect-editor`、`--id`、`--management-id` 三者互斥。`--inspect-editor` 仅在原标签页读取 DOM，不上传或提交。`editor.ready` 仅表示视频元数据就绪，`editor.can_submit` 才额外要求声明、封面及发表按钮可用。prepare 先保存并重开草稿，满足 can_submit 时返回 prepared，否则返回 draft_saved；CSS 禁用类与原生 disabled 属性均检查。

`management_id` 保存管理页 export/... ID，`id` 保存数字统计 ID，二者不互换。管理通道复用 normalizePost，按精确 ID、描述、发布时间和已发表状态匹配，连续两次唯一稳定后更新记录；每次新鲜导航，当前只读取已加载卡片。`metrics_source=management_cumulative` 表示新作品累计值，缺失不补零，analytics=null；该通道不接受日期参数。数字统计通道仍为 metrics_source=statistics，保留原日期与指标契约。

原发布编辑页仍打开时，`video-status --id` 会拒绝跳转去统计页，避免丢失正在编辑的内容；此时使用独立的 `posts` / `post-detail` 命令读取历史数据。

| 状态 | 含义 |
| --- | --- |
| `preparing` / `preparation_unknown` | 准备中或准备未确认；不得自动重传，先检查原标签页 |
| `draft_saved` / `draft_save_unknown` | 草稿已保存但当前尚不能提交／保存回执未知；未知时禁止自动重存 |
| `prepared` | 平台草稿已保存并重开核对，尚未发表，等待用户确认 |
| `requires_user_action` | 验证、权限、协议等需要人工处理；结合 `submitted` 判断是否已经尝试过提交 |
| `submit_unknown` | 点击前已落盘；连接丢失或无可靠回执，不允许自动重发 |
| `submitted` | 页面提示提交成功，尚不能当作审核通过或公开发表 |
| `published` | 显式数字 objectId 匹配并读取原统计，或显式管理 ID 匹配当前账号已发表记录并读取累计数据；不等于公开链接验收通过 |

记录在发表点击之前持久化，并使用排他锁阻止同一记录并发执行。任何已尝试提交的记录再次调用都不会点击发表；进程异常留下 `.lock` 时，先确认原进程结束并核对远端状态，再由人工处理锁文件。不要为重试随意更换记录路径，否则会丢失防重依据。

`video-status --id` 复用现有 `_shared/client.js`、`normalizePost` 和 `normalizeDetail`，不会建立另一套字段映射。返回的 `metrics` 是作品累计指标，`analytics` 是指定日期窗口的详情；仍截至上海昨日，当日未入统计窗口不代表发表失败。未提供 `--id` 时只读本地快照，提供 ID 才刷新远端状态；不按标题自动猜 ID。

收藏尚无已核实的独立后台字段；原有 `likes` 是“喜欢”，不能改名当作“收藏”。本次没有补造收藏值。

Chrome 扩展需加载本次 `npm run build:extension` 产物后，专用文件上传动作才支持 open Shadow DOM。CSS/语义查找和 ref 解析同步支持 open shadow roots；跨 iframe、closed shadow roots 不在本次扩展范围。没有开放额外 raw CDP 方法。
