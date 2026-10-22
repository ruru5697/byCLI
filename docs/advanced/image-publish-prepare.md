# 小红书图文发布准备

`xiaohongshu publish-images --prepare` 只完成图片上传和字段填写，停在最终发布前；另有独立review、submit和status模式，正式发布必须取得用户对具体内容的明确授权。没有显式存草稿模式。需要Chrome中的byCLI扩展已连接、创作平台已登录。

```bash
node dist/src/main.js xiaohongshu publish-images --prepare --input ./images.json --timeout 300 -f json
```

清单示例，图片路径相对于JSON所在目录：

```json
{
  "images": ["01.png", "02.png", "03.png", "04.png"],
  "title": "我被一杯咖啡面试了",
  "body": "第一段。\n\n第二段。",
  "declaration": "笔记含AI合成内容",
  "visibility": "public",
  "accountId": "1234567890"
}
```

images为1–18张按顺序排列的PNG/JPEG/静态WebP，每张不超过32 MiB；不支持重复图片内容、GIF、动画PNG/WebP。结构检查不替代完整图片解码，网站无法解码或上传失败时不会返回准备成功。本轮真实验收使用4张PNG。标题1–20、正文1–1000个JavaScript字符单位，不静默截断。

声明必须明确提供，可为none、虚构演绎，仅供娱乐、笔记含AI合成内容、内容包含营销广告。none表示保留未选内容类型声明；不自动启用原创声明。accountId为可选的预期公开账号编号，建议始终提供。仅支持公开、非定时发布，未支持的字段直接报错。

程序在上传前检查已有编辑器及账号；逐张上传并等待状态完成，按File对象内容摘要验证图片与顺序，检查完整预览尺寸、标题正文、声明、可见性和首图默认封面。当前不裁切、不拖拽重排、不生成独立封面；按清单中的原始图片准备。网站缩略图可以使用object-fit:cover，这不表示完整图片已被裁切。

成功返回ready_for_confirmation、submitted=false、job_id、image_count、账号、报告与截图。状态目录默认为~/.bycli，可用BYCLI_CONFIG_DIR覆盖。图文作业contentType=image，不能交给视频提交命令。ready_for_confirmation表示当前准备检查通过；review生成30分钟确认码，提交前须重新核对。确认码不等同于用户发布授权。

编辑器保留供检查。重复准备遇到已有编辑器会返回EXISTING_EDITOR；先确认当前内容，再决定是否关闭，不要反复重新上传。关闭页面后不能依靠本地job.json自动恢复远端草稿。平台自动保存不是本命令的持久化保证，remoteDraftId目前为null。

本机账号绑定的验收素材、回执和实验脚本不随包分发。可用性与验证范围见[原生连接器说明](../guide/native-connectors.md)。


## 人工确认、单次提交与状态

```bash
node dist/src/main.js xiaohongshu publish-images --review JOB_UUID -f json
# 用户明确批准这条内容公开发布后：
node dist/src/main.js xiaohongshu publish-images --submit JOB_UUID --confirm TOKEN_FROM_REVIEW -f json
node dist/src/main.js xiaohongshu publish-images --status JOB_UUID -f json
```

准备、复核、提交、状态四种模式互斥；input仅用于prepare，confirm仅用于submit。图文命令拒绝视频作业，视频命令拒绝图文作业。

review重新验证所有本地图片和浏览器上传身份，绑定账号、图片顺序、内容和发布设置。提交在原生捕获启动后再次核对，再写入唯一attempt，最后通过不自动重试的evaluateOnce调用一次小红书发布控件。执行或通信错误、未知回执均不重发。任何有attempt的作业都不能再次submit，即使平台拒绝也需先检查现场。

回执只保留白名单状态和精确内容ID；accepted仅表示受理。已发布状态来自同账号管理筛选列表中的精确图文记录。无ID时不猜标题；结果不明不补发。当前只查询各筛选第一页，未找到不意味着删除。

未提交status仅返回本地状态。已提交查询可以恢复已关闭的管理页；当前会话有图片或视频编辑器时返回EDITOR_IN_USE，保留编辑页，不在同一持久会话中新开替代查询标签。当前示例已按用户授权正式发布一次并通过后台精确ID状态核对。首发回执因缺少code保留为未知，现已兼容严格success=true的无code响应；新兼容分支仍需后续正常获授权发布取样，不能为了测试额外发帖。

本机账号绑定的验收素材、回执和实验脚本不随包分发。可用性与验证范围见[原生连接器说明](../guide/native-connectors.md)。

## 图文单篇数据

```bash
node dist/src/main.js xiaohongshu stats --type image --content-id 000000000000000000000001 --account-id 1234567890 --scope content -f json
```

默认type仍为video；图文必须显式提供image。先按账号管理列表精确ID核对图文类型，再采集详情9项指标：曝光数、观看数、封面点击率、平均观看时长、涨粉数、点赞数、评论数、收藏数、分享数。保留后台原标签、原值、数值与可用性；占位值为null，真实0为0，不补视频专属指标。

查询是当前详情值，不是区间增量；平台未提供统一更新时间时dataAsOf为null。低观看量下部分数据、诊断、画像不可用。精确类型确认目前只查管理筛选第一页，缺失不猜测；指标标签缺失或重复也明确失败。已有编辑器时沿用查询保护，不替换编辑页。

本机账号绑定的验收素材、回执和实验脚本不随包分发。可用性与验证范围见[原生连接器说明](../guide/native-connectors.md)。
