# CSDN 文章发布准备

`csdn publish-article --prepare`通过byCLI原生Page、daemon和Chrome扩展操作CSDN Markdown编辑器。prepare模式负责正文、封面上传裁剪、远端草稿保存和重开核对，不执行最终发布。另有review/submit/status和人工授权后的recover，详见本文末尾补充；数据采集使用`csdn stats`，见[单篇文章数据采集](csdn-article-stats.md)。

```bash
node dist/src/main.js csdn publish-article --prepare --input article.json --timeout 300 -f json
```

需要扩展已连接，并在Chrome登录目标CSDN账号。每次仅使用一个受控实验页；已有受控页面时直接返回EXISTING_EDITOR，不通过新标签绕过。

## 清单与范围

```json
{
  "title": "别让一次超时变成两次下单：JavaScript 重试边界实验",
  "body": "Markdown正文，使用LF换行。",
  "cover": "cover.png",
  "summary": "明确填写的单行摘要。",
  "tags": ["javascript", "前端"],
  "articleType": "original",
  "visibility": "public",
  "declaration": "部分内容由AI辅助生成",
  "accountId": "csdn_demo_author",
  "columns": [],
  "backupToGitCode": false,
  "multiPlatform": false,
  "template": "默认模板",
  "activities": [],
  "topics": []
}
```

当前命令限制：标题5–100、正文1–80000、摘要1–256个JavaScript字符单位，标签1–7个且不能重复。标题和摘要单行；正文保留原始Markdown，支持标题、代码、引用、列表等文字结构，不支持正文图片、视频和活动HTML。长度是本版输入范围，不宣称平台所有边界都完成真实实测。

本版仅支持原创、默认公开候选、部分内容由AI辅助生成声明和默认模板。分类专栏、活动、话题明确为空；GitCode备份和多平台发布明确关闭，不配置定时发布。public仅表示将来的发布候选设置，草稿保存后仍为草稿，并未公开。

封面是相对清单路径的静态PNG/JPEG，小于5 MiB，至少356×200，精确89:50比例。该比例对应本次实际观察到的CSDN固定裁剪尺寸，避免自动裁掉标题。实际使用1424×800 PNG，经网站裁剪为356×200。GIF等格式暂不支持，JPEG未在本轮真实上传。

## 编辑器与封面核对

CSDN标题输入框初始隐藏。命令先点击显示标题，再等待真正的输入框可见才输入，提交标题后立即逐字检查正文未被误写。Markdown通过网站现有文件导入功能新建本地文件，保留原文件元数据，不覆盖恢复出的旧稿。网站可能自动创建远端草稿。

实际发布数据以`file/current`和`content/current`为准。标签和封面组件可能保留旧的局部缓存，因此不以组件初始字段代替真正的文件设置；同时检查可见标签、摘要、封面预览与模型一致。自动补充的关联标签会通过正常删除控件移除，只保留清单指定的标签。

封面上传前计算本地SHA256，文件选择后在网站清空输入前读取浏览器File核对大小与摘要；对网站实际裁剪结果记录356×200尺寸及摘要，再核对上传后的资源身份和图片加载。媒体地址只在浏览器内用于核对，报告只保存摘要，不落盘签名地址。

有封面时网站会移除文件输入；失败恢复若需要替换封面，先使用当前候选的正常移除封面控件，再上传。上传成功后的裁剪窗口如未关闭，先确认最终图片已应用，再使用正常关闭控件。不会把关闭窗口本身当作上传成功。

对可逆的准备控件使用限定DOM点击处理器，防止嵌套弹窗的坐标点击落到别处；辅助函数明确禁止点击发布面板中的最终“发布文章”和“定时发布”。只有编辑器外的同名按钮用于打开设置。

## 草稿保存、恢复与保护

明确点击“保存为草稿”，等待网站成功提示、新完成的saveArticle请求、草稿状态2和远端ID。CSDN保存草稿后可保留发布窗口，所以不能等待它自动消失作为成功条件。

随后关闭唯一受控页，按`https://editor.csdn.net/md?articleId=DRAFT_ID`重新加载远端草稿，逐项验证完整正文、账号、标题、封面、摘要、标签与发布设置。无参数的`/md/`可能进入新建文章，并不是可靠的草稿恢复入口。重开后本地文件ID允许变化，远端草稿ID必须一致。

可选模板选择器只执行“取消”，不添加模板正文。CSDN使用弹窗队列，模板选择器可能排在发布窗口后面；命令通过正常关闭/取消/重开控件清理已知可选模板窗口，再核对当前只显示发布设置。未知弹窗停止保留现场。

成功返回ready_for_confirmation、submitted=false、job_id、draft_id、报告和截图。报告保存在`~/.bycli/publish-jobs/csdn/JOB_UUID/job.json`，也支持BYCLI_CONFIG_DIR。目录700、文件600，独占锁加原子写入，记录失败阶段及恢复信息。

```bash
node dist/src/main.js csdn publish-article --prepare --resume JOB_UUID --input article.json -f json
```

仅允许同一失败作业、同一清单和素材、同一保留的本地文件恢复。必须核对账号、文件ID、原正文和记录的标题，不能覆盖手工修改。已有完整上传绑定且所有设置核对通过时，可直接补做保存/重开验证；已准备成功的任务不能resume覆盖。prepare与resume不会执行最终发布。提交、回执与状态入口见下方补充。

本机账号绑定的验收素材、回执和实验脚本不随包分发。可用性与验证范围见[原生连接器说明](../guide/native-connectors.md)。


## 发布提交与状态补充

本机账号绑定的验收素材、回执和实验脚本不随包分发。可用性与验证范围见[原生连接器说明](../guide/native-connectors.md)。
