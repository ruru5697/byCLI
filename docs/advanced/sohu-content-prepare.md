# 搜狐号图集与文章发布准备

原生浏览器命令的prepare模式只完成准备，不点击发布、定时发布或存草稿；另有独立review、submit、status以及save-draft、draft-status、open-draft模式。页面可能自动保存草稿及将上传图片同步至素材库；`remoteDraftId=null`，本地报告不保证远端草稿持久化。需要Chrome中的byCLI扩展已连接、搜狐号已登录。

```bash
node dist/src/main.js sohu publish-gallery --prepare --input ./gallery.json --timeout 300 -f json
node dist/src/main.js sohu publish-article --prepare --input ./article.json --timeout 300 -f json
```

每次只准备一项。当前受控会话有编辑页或未知页面时返回EXISTING_EDITOR，不覆盖内容、不新开替代标签。编辑器加载完成后若恢复已有标题、正文或图片，也停止并保留现场。成功返回ready_for_confirmation、submitted=false、job_id、账号、报告和截图；准备结果不能作为发布授权；review生成的确认码也不能代替用户对具体内容的明确发布授权。

## 图集清单

```json
{
  "title": "我被一杯咖啡面试了",
  "images": [
    {"path":"01.png","description":"第一幕：买咖啡变成参加面试。"},
    {"path":"02.png","description":"第二幕：熬夜居然是咖啡的技能。"},
    {"path":"03.png","description":"第三幕：明天星期一，情绪稳定结束。"},
    {"path":"04.png","description":"第四幕：好的，杯总。"}
  ],
  "cover": "01.png",
  "category": ["搞笑","综合"],
  "declaration": "含有AI生成内容",
  "visibility": "public",
  "accountId": "123456789"
}
```

图集支持3–40张有序图片，每张配文1–200个JavaScript字符单位。标题为5–72个字符单位、单行。分类提供时须给出两个层级；也可省略category，上传后返回category_required和可恢复作业ID。通过当前编辑器读取真实分类，再用resume继续同一作业，无需重新上传。视频和图集分别读取自己的控件，长列表目标滚动到可见区域后点击并回读验证。

## 文章清单

```json
{
  "title": "我被一杯咖啡面试了：今天开始喊它杯总",
  "body": "第一段正文。\n\n第二段正文。",
  "summary": "一场买咖啡引发的荒诞面试。",
  "images": ["01.png","02.png","03.png","04.png"],
  "cover": "01.png",
  "attribute": "none",
  "declaration": "含有AI生成内容",
  "visibility": "public",
  "accountId": "123456789"
}
```

当前文章支持1–20000字符单位的纯文本正文、1–120字符单位的单行摘要，以及1–20张按顺序追加在正文末尾的图片。正文使用LF换行，末尾不添加多余空行。标题与图集限制一致。attribute仅支持显式none，保持“属性／未选择”；话题、栏目、活动征稿不自动选择。未实现Markdown/HTML解析、图文任意交错、原创属性、引用声明和登录阅读全文限制。

文章“必须登录才能查看全文”控件必须存在、可见且未勾选；缺失或开启时不返回准备成功。当前public表示平台默认公开候选设置，尚未正式提交，不能据此声称线上作品已公开。

## 图片与完成检查

本版统一支持静态PNG/JPEG，每张小于10 MiB，正文/图集图片宽高均大于250，封面大于450×300。不接受GIF/WebP、重复图片内容。文章图片文件名必须各不相同，用于校验平台再次上传后的顺序。所有路径相对于清单文件。未知字段直接报错。

准备前验证文件结构、尺寸和SHA256，上传后从网站组件保留的File对象再次核对选中文件的摘要及顺序。搜狐会清空文件输入框，不能将空FileList误判为选错文件。图集继续核对模型里的File内容、图片状态、尺寸、配文及分类。

文章插图会经编辑器再次上传，临时地址变化属于正常流程；先核对选中文件摘要，再等待正文每个IMG关联的上传任务为success，并核对最终文件名、尺寸和顺序、图片加载完成及最终远端身份摘要。最终远端媒体可能经平台转码，不声称远端像素或字节与本地原图相同。正文文字逐字、换行核对，排除编辑器图片描述控件的提示文案。

封面独立上传并核对选中文件SHA256、应用后的背景身份摘要；当前使用单张封面，无程序化裁切或三图封面。竖图在封面和图集列表缩略框内会裁切显示，正文图片保留完整1080×1440尺寸。本轮图集真实验证4张PNG，独立新故事文章真实验证3张PNG，其他数量边界与JPEG仅本地校验测试，不冒充全量站点实测。

报告另核对预期账号、声明、弹窗关闭、剩余额度>0、发布控件存在且未禁用；本地文件在准备完成时再次校验。发布控件可用不代表提交时平台一定通过所有服务端校验。

状态和数据查询在搜狐编辑页存在时返回EDITOR_IN_USE，保留现场；不能通过新开同租约查询标签绕过。一次一个编辑页，结束后自行决定是否关闭。关闭后不要把原准备报告当成仍可提交的作业。

本机账号绑定的验收素材、回执和实验脚本不随包分发。可用性与验证范围见[原生连接器说明](../guide/native-connectors.md)。


该脚本不重新上传、不提交，临时切换登录全文限制以验证检查器，然后恢复未勾选；需要原编辑页仍存在。它会保留这一个页面供验收。

本机账号绑定的验收素材、回执和实验脚本不随包分发。可用性与验证范围见[原生连接器说明](../guide/native-connectors.md)。


## 复核、单次提交、回执与状态

```bash
# 以下复核/提交示例中的JOB_UUID指新准备且从未提交的对应类型作业
node dist/src/main.js sohu publish-gallery --review JOB_UUID -f json
node dist/src/main.js sohu publish-gallery --submit JOB_UUID --confirm TOKEN_FROM_REVIEW -f json
node dist/src/main.js sohu publish-article --review JOB_UUID -f json
node dist/src/main.js sohu publish-article --submit JOB_UUID --confirm TOKEN_FROM_REVIEW -f json

# 已经提交的两个样本只查询状态，不再提交
node dist/src/main.js sohu publish-gallery --status de397d2d-28d2-4891-8533-79079838aab3 -f json
node dist/src/main.js sohu publish-article --status 021a0da7-f566-47fa-b2c4-32709065f32c -f json
```

prepare/review/submit/status互斥，input仅用于prepare，confirm仅用于submit；两类命令也不能操作对方或视频作业。review重新验证本地文件与浏览器已上传媒体身份、账号、正文/配文、封面和选定设置，签发30分钟确认码。发布前必须获得用户对具体内容的明确授权。

新准备作业及仍在原受控编辑页中的draft_saved作业可以review。review绑定已有远端草稿ID（如果URL已经给出）；不会按标题恢复任意草稿。未保存的编辑页关闭时返回EDITOR_MISSING；已验证的draft_saved作业可用open-draft按精确ID重开并复核，再重新review，不能靠旧报告直接提交。文章自动保存会合并空白段间距，review允许这种空白段差异，非空段落文字仍须逐字一致；生成确认码之后的正文/设置变化均会使submit失败。

submit启动对应类型的精确响应捕获并再次复核，持久化唯一attempt后，仅以evaluateOnce点击一次已知发布控件。图集回执只认publishAlbum/v2，文章只认publish/v2，不接受视频、存草稿、其他类型或其他域名响应。两类新接口均要求HTTP成功、code=2000000且success严格为true。缺失/多条/截断/矛盾回执和可能已发出的通信故障均保留未知，不自动重发；任何已有attempt的作业再次review/submit均返回ALREADY_ATTEMPTED。

accepted只代表受理。status用回执或已独立验证的精确内容ID，在当前准备账号的管理列表中确认数值类型（图集3、文章2）及逐条状态。输出query_status、public_url和receipt_status；已发布公开地址只允许同ID、同账号的搜狐公开页面。类型不符为query_unavailable；当前第一页未找到是not_found，均不把已有成功状态改成删除。未提交且无回执的status只返回本地状态。

已提交的历史原生发布作业可以直接使用正式status，不要求补造review令牌，也不重写其原始回执。status可以在查询页已关闭后恢复管理页；有文章/图集/视频编辑器时保留现场并返回EDITOR_IN_USE，不新开替代租约页面。

本机账号绑定的验收素材、回执和实验脚本不随包分发。可用性与验证范围见[原生连接器说明](../guide/native-connectors.md)。


## 发布后的图集与文章数据

本机账号绑定的验收素材、回执和实验脚本不随包分发。可用性与验证范围见[原生连接器说明](../guide/native-connectors.md)。


## 分类发现、失败恢复和编辑器释放（2026-10-22 本地修复）

以下命令与发布、stats使用相同的搜狐持久适配器会话。它们不使用通用browser会话枚举适配器页签；不重启浏览器，也不绕过编辑器保护。

```bash
bycli sohu editor -f json
bycli sohu editor --open PAGE_ID
bycli sohu editor --categories -f json
# 选择当前形态的一级分类并列出它的二级分类；这一步会改变编辑器中的一级选中值
bycli sohu editor --categories --primary 搞笑 -f json
bycli sohu publish-gallery --resume JOB_UUID --category '["搞笑","综合"]' -f json
bycli sohu publish-video --resume JOB_UUID --category '["科技","黑科技"]' -f json
# 用户明确放弃当前准备后，精确关闭该页签并清除本地作业的页签绑定和旧review
bycli sohu editor --close PAGE_ID --discard -f json
```

resume仅支持本版本产生的selecting_category检查点（category_required或该阶段failed）；复验本地文件、原账号及已上传素材，补齐分类和声明后更新原作业，不重新上传。旧版本没有检查点的失败作业不自动迁移。恢复后重新生成预览，仍未提交。

## 显式保存和恢复文章、图集草稿（2026-10-22 本地修复）

```bash
bycli sohu publish-article --save-draft JOB_UUID -f json
bycli sohu publish-gallery --save-draft JOB_UUID -f json
# 保存响应不明时只复查，绝不再次点击
bycli sohu publish-gallery --draft-status JOB_UUID -f json
# 已验证保存的草稿在关闭原编辑器后按精确ID重新打开
bycli sohu publish-gallery --open-draft JOB_UUID -f json
```

save-draft独立于prepare和submit；已有发布attempt的作业禁止保存草稿。操作前复验内容、素材、账号及控件，持久化draftSaveAttempt后，以nativeClickOnce向精确命中的“存草稿”按钮发送一次原生鼠标手势，不调用发布。保存成功须精确核对所属账号的管理记录为草稿（status=1，文章type=2、图集type=3），再按同一ID重新打开，验证正文/逐图配文、顺序、媒体身份、封面和设置。计数增加或点击返回均不构成成功。

保存返回draft_saved与remote_draft_id，保留重开的编辑器；需要运行stats时，先用editor关闭该编辑器。草稿身份仍保留，可用open-draft恢复，发布前须重新review。当前一次作业只允许一次显式保存手势；已验证保存后的重复save-draft返回同一草稿ID，不重复点击；未确认结果时重复save-draft报DRAFT_SAVE_ALREADY_ATTEMPTED，使用draft-status核对。结果不明为draft_save_unknown，保留attempt和现场，不自动重复保存或发布。

当前保存响应兼容仅把同源save/draft端点的明确成功ID作为候选，publish端点不能证明保存草稿；候选ID仍需管理记录与重开内容双重验证。未知响应、第一页未找到、媒体URL身份变化或站点控件变化均明确保留未验证结果。

视频仍只提供实时编辑器准备，未实现可靠远端草稿保存；不能将视频prepare结果称为进入草稿箱。以上新增流程已完成本地DOM及状态机测试，尚未完成本轮真实网站保存验收。
