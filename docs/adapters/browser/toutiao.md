# Toutiao (今日头条)

**Mode**: 🌐 / 🔐

| Command | Mode | Domain | Description |
|---------|------|--------|-------------|
| `bycli toutiao articles` | 🔐 Browser | `mp.toutiao.com` | 头条号创作者后台文章列表及数据（需登录） |
| `bycli toutiao hot` | 🌐 Public | `www.toutiao.com` | 今日头条首页热榜（公开，无需登录） |
| `bycli toutiao search <query>` | 🌐 Public | `www.toutiao.com` | 今日头条公开站内搜索（无需登录） |

## Usage Examples

```bash
# Public hot board (no login)
bycli toutiao hot
bycli toutiao hot --limit 10
bycli toutiao hot -f json

# Public site search (no login)
bycli toutiao search "人工智能"
bycli toutiao search "人工智能" --type information
bycli toutiao search "人工智能" --type video
bycli toutiao search "人工智能" --limit 10
bycli toutiao search "人工智能" --limit 10 -f json

# Creator dashboard articles (logged-in)
bycli toutiao articles
bycli toutiao articles --page 2
bycli toutiao articles --page 1 -f json
```

## Output

### `hot`

| Column | Type | Notes |
|--------|------|-------|
| `rank` | int | 1-based, dense after empty-title rows are dropped |
| `group_id` | string \| null | Topic/cluster id (`ClusterIdStr`, falls back to numeric `ClusterId`) |
| `title` | string | Trending topic title |
| `query` | string | Search keyword (`QueryWord`); falls back to `title` if absent |
| `hot_value` | int \| null | `HotValue` parsed as non-negative number; `null` if missing |
| `label` | string \| null | Hot tag (e.g. 热 / 新 / 沸) when present |
| `url` | string \| null | Topic permalink |
| `image_url` | string \| null | First non-empty image URL (`Image.url` → `Image.url_list[*]`) |

### `articles`

`title` · `date` · `status` · `展现` · `阅读` · `点赞` · `评论`

If a row's stats span has not finished rendering by the time the page text is read, the row still surfaces with `null` stat columns instead of being silently dropped — this masking previously hid creator-backend slow-render bugs.
Login/captcha pages abort with `AuthRequiredError`; browser render failures abort with `CommandExecutionError`.

### `search`

| Column | Type | Notes |
|--------|------|-------|
| `rank` | int | 1-based result rank |
| `title` | string | Search result title |
| `url` | string | Result or article URL |
| `source` | string \| null | Publisher/source name |
| `publish_time` | string \| null | Published or displayed time from the result |
| `summary` | string \| null | Result abstract |
| `image_url` | string \| null | First available result image |
| `like_count` | int \| null | Like/digg count |
| `comment_count` | int \| null | Comment count |
| `share_count` | int \| null | Share/repost/forward count when provided |
| `read_count` | int \| null | Read count when provided |

The public search page is parsed without login. Optional fields that the upstream result does not provide are returned as `null` rather than dropping the result.

`--type` defaults to `synthesis` and accepts `synthesis`, `information`, `video`, `atlas`, `user`, `xiaoshipin`, `weitoutiao`, or `music`.

## Prerequisites

### `hot`
- No login required. Uses the public `hot-event/hot-board` endpoint that powers the homepage hot panel.

### `search`
- No login required. Searches the public Toutiao site search page.

### `articles`
- Chrome running and **logged into** `mp.toutiao.com`
- [Browser Bridge extension](/guide/browser-bridge) installed

## Notes

- `hot` `--limit` accepts integers in `[1, 50]`; out-of-range values raise an `ArgumentError` (no silent clamp).
- `articles` `--page` accepts integers in `[1, 4]`, matching the contributor's verified range on the creator dashboard; out-of-range values raise an `ArgumentError`.
- `search` `--limit` accepts integers in `[1, 50]`; the default is 20 and out-of-range values raise an `ArgumentError`.

## 文章和视频下载

```bash
bycli toutiao article-download ARTICLE_URL_OR_ID --output ./downloads --output-format md -f json
bycli toutiao article-download ARTICLE_URL_OR_ID --output ./downloads --output-format json -f json
bycli toutiao video-download VIDEO_URL_OR_ID --output ./downloads -f json
```

文章命令用 Chrome 渲染正文，固定等待页面内容加载后提取；可传头条文章链接或8至32位数字ID。`--output-format` 控制下载文件，`-f` 控制命令输出。视频命令保存页面暴露的视频源。文件名按UTF-8字节截断，给中文长标题保留安全的文件名长度。这些入口不提供小红书、搜狐号下载器的MP4结构验证能力；遇到登录墙、反爬页面或无正文/视频源时会报错。

## 内容发布

| 命令 | 内容与必要参数 | 执行结果 |
|---|---|---|
| `bycli toutiao article-publish TITLE` | `--content TEXT` 或 `--content-file PATH` | 默认预检，`--execute` 上传填写并提交文章 |
| `bycli toutiao image-publish TITLE` | `--image PATH`，执行时需 `--content MARKDOWN_PATH` | 默认预检，`--execute` 提交微头条图文 |
| `bycli toutiao video-publish TITLE` | `--video PATH`，执行时还需 `--cover PATH` | 默认预检，`--execute` 提交视频 |

所有 `--execute` 操作都需要用户对当前账号、正文、素材和发布设置的明确授权。它们不使用小红书等连接器的job/review协议。

```bash
# 仅预检
bycli toutiao article-publish '文章标题' --content-file /absolute/body.txt -f json
bycli toutiao image-publish '图文标题' --image /absolute/cover.jpg --content /absolute/story.md -f json
bycli toutiao video-publish '视频标题' --video /absolute/video.mp4 --cover /absolute/cover.jpg -f json
```

文章标题2至30字符，正文按纯文本填写。图文入口是微头条：当前实现最多取原始Markdown正文的2000字符，超出时按段落截取并在返回消息说明，预览时应核对截取结果。视频执行时必须有封面，需要平台允许的文件输入与裁剪交互。

`submitted` 表示已执行提交，不代表审核通过；`pending` 表示点击后作品列表暂未确认。结果未知时先核对平台作品管理，不自动重复执行。

## 单篇统计和评论

```bash
bycli toutiao article-stats '精确文章标题' -f json
bycli toutiao video-stats '精确视频标题' -f json
bycli toutiao article-comments '精确文章标题' -f json
```

三个命令都读取当前作品管理页。参数是查询字符串；实现按可见标题或文本查找，优先传精确标题。URL或数字ID没有出现在当前页面时不会自动解析为标题，也不提供遍历全部分页的保证。未命中会报错，不应解释成作品被删除。

统计返回 `found`、标题、状态、展现、播放或阅读、点赞、评论及原始文本。计数保留平台显示字符串，可能含逗号；缺失为 `null`，不是指定日期区间的增量。评论命令当前返回总数、空状态及面板原文，`comments` 数组仍为空，不提供完整逐条评论的采集承诺。
