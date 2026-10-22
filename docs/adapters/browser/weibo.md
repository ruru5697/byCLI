# Weibo (微博)

**Mode**: 🔐 Browser · **Domain**: `weibo.com`

## Commands

| Command | Description |
|---------|-------------|
| `bycli weibo hot` | 微博热搜 |
| `bycli weibo search` | Search Weibo posts by keyword |
| `bycli weibo feed` | 首页时间线（`for-you` / `following`） |
| `bycli weibo user` | 用户信息 |
| `bycli weibo user-posts` | 按用户列出微博，可选日期范围 |
| `bycli weibo me` | 我的信息 |
| `bycli weibo post` | 读取单条微博 |
| `bycli weibo favorites` | 我的微博收藏列表 |
| `bycli weibo publish` | 通过网页 UI 直接发布微博，支持最多 9 张图片 |
| `bycli weibo delete` | 删除登录账号自己的单条微博 |
| `bycli weibo comments` | 微博评论 |

## Usage Examples

```bash
# Quick start
bycli weibo hot --limit 5

# JSON output
bycli weibo hot -f json

# Search
bycli weibo search "OpenAI" --limit 5

# Home timeline (default: for-you / 推荐流)
bycli weibo feed --limit 10

# Following-only timeline (strict chronological following feed)
bycli weibo feed --type following --limit 10

# Read a post from feed/search using the emitted id
bycli weibo post <id>

# List a user's posts by uid or screen name
bycli weibo user-posts 1670458304 --start 2025-06-01 --end 2025-06-02 --limit 20

# Verbose mode
bycli weibo hot -v

# Favorites
bycli weibo favorites --limit 20

# Publish text (executes immediately)
bycli weibo publish "Hello from byCLI"

# Publish text with images (executes immediately)
bycli weibo publish "Hello with images" --images /path/a.jpg,/path/b.png

# Delete one of your own posts (executes immediately)
bycli weibo delete <id>
```

## Listing Columns

`feed`, `search`, and `user-posts` expose `id` for post rows. Pass that value
directly to `bycli weibo post <id>`. `hot` rows are search topics, not post
rows.

## Prerequisites

- Chrome running and **logged into** weibo.com
- [Browser Bridge extension](/guide/browser-bridge) installed

## 内容下载和分类统计

下面的读取命令复用当前 Chrome 登录态，接受微博数字 ID、mblogid 或对应链接。长文章下载另支持 `ttarticle` 文章链接。查询作品不存在、登录失效或响应结构不符时会报错。

| 命令 | 用途 |
|---|---|
| `bycli weibo article-download TARGET` | 下载长文章或长文本，输出 Markdown 或 JSON |
| `bycli weibo image-download TARGET` | 按微博原始图片顺序下载图片 |
| `bycli weibo video-download TARGET` | 下载微博接口提供的可播放视频 |
| `bycli weibo short-stats TARGET` | 短微博互动数据 |
| `bycli weibo image-stats TARGET` | 图片微博互动数据 |
| `bycli weibo video-stats TARGET` | 视频微博互动数据 |
| `bycli weibo article-stats TARGET` | 长文章关联微博的互动数据 |

```bash
bycli weibo article-download ARTICLE_URL --output ./downloads --output-format md -f json
bycli weibo article-download ARTICLE_URL --output ./downloads --output-format json -f json
bycli weibo image-download POST_ID --output ./downloads -f json
bycli weibo video-download POST_ID --output ./downloads -f json
bycli weibo video-stats POST_ID -f json
bycli weibo comments POST_ID --sort time --limit 20 --include-replies -f json
```

`--output-format` 控制文章文件格式；`-f json` 控制命令结果格式。下载标题按 UTF-8 字节限制长度，给作品编号和扩展名保留空间，中文长标题也能落盘。文件是平台提供的媒体版本；新增微博下载入口不提供与小红书、搜狐号相同的 MP4 完整结构验证承诺。

分类统计同时返回检测到的内容类型和请求类型；类型不符会报错。`views` 和 `video_plays` 未提供时为 `null`，其他互动计数沿用该接口适配的默认值，不能当作创作者后台已结算的统计。`observed_at` 是读取时刻。长文章应传关联微博的 ID 或链接，不能把文章编辑器草稿 ID 当作微博 ID。

评论的 `--limit` 范围为1至100，越界或非整数会报错。`--cursor` 可继续上次返回的分页游标；`--include-replies` 保留结构化回复，跨页按评论编号去重。

## 图文和视频发布

新入口 `image-publish`、`video-publish` 默认只预检；只有 `--execute` 才执行发布动作。运行前必须取得用户对当前账号、文字、图片、视频及声明的明确授权。它们不使用小红书等连接器的 job/review 确认码协议；旧的 `weibo publish` 仍会直接执行发布，不要把它当作预检命令。

```bash
# 预检，不公开提交
bycli weibo image-publish '微博正文' --images /absolute/one.jpg,/absolute/two.png -f json
bycli weibo video-publish '视频正文' --video /absolute/video.mp4 --ai-generated -f json

# 用户确认这份具体内容后，才单独添加 --execute
bycli weibo image-publish '微博正文' --images /absolute/one.jpg,/absolute/two.png --execute -f json
```

视频正文最多2000字符，前30字符用作视频标题；支持mp4、mov、m4v和webm。`--ai-generated` 按素材实际情况选择。视频发布结果不明时，先手工查看视频管理，不能自动重发。

## 长文章草稿

`article-publish` 默认预检；添加 `--execute` 后只保存长文章草稿。正式发布需要在平台草稿中人工点击“下一步”、完成滑块身份校验并确认发布。

```bash
bycli weibo article-publish --title '文章标题' --content-file /absolute/article.html --cover /absolute/cover.jpg -f json
# 明确同意保存该草稿后执行
bycli weibo article-publish --title '文章标题' --content-file /absolute/article.html --cover /absolute/cover.jpg --execute -f json
```

标题最多32字符，导语 `--summary` 最多44字符。正文支持纯文本或离线准备的HTML；Markdown文件需先离线转换成HTML。HTML中的本地图片按正文文件目录解析，再上传替换；远程图片限受支持的新浪图片地址。返回 `draft_id`、正文来源、正文长度、配图说明和草稿链接。`draft-saved` 只表示草稿保存成功。
