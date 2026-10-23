# 原生内容连接器

byCLI提供小红书、搜狐号、掘金和CSDN的内容发布与单篇数据命令。视频下载使用原生HTTP和有界MP4校验，发布与数据读取使用当前Chrome登录会话。需要启用本地Browser Bridge扩展并登录目标平台。

## 命令入口

以下命令以前缀`bycli`运行；在仓库内也可使用`node dist/src/main.js`。

| 平台与内容 | 发布命令 | 数据命令 |
|---|---|---|
| 小红书视频 | `xiaohongshu publish-video` | `xiaohongshu stats --type video` |
| 小红书图文 | `xiaohongshu publish-images` | `xiaohongshu stats --type image` |
| 搜狐号视频 | `sohu publish-video` | `sohu stats --type video` |
| 搜狐号图集 | `sohu publish-gallery` | `sohu stats --type gallery` |
| 搜狐号文章 | `sohu publish-article` | `sohu stats --type article` |
| 掘金文章 | `juejin publish-article` | `juejin stats --type article` |
| CSDN文章 | `csdn publish-article` | `csdn stats --type article` |

视频下载入口为`xiaohongshu download URL --type video`及`sohu download URL`，详见[下载说明](../advanced/download.md)。小红书应使用当前有效的完整签名链接或xhslink短链接。

## 发布确认和任务身份

各发布命令的prepare、review、submit、status互斥。准备成功或拿到确认码都不能替代用户对当前内容的明确发布授权。

```bash
bycli csdn publish-article --prepare --input article.json -f json
bycli csdn publish-article --review JOB_UUID -f json
# 用户明确确认当前账号、正文、素材及发布设置之后，单独执行
bycli csdn publish-article --submit JOB_UUID --confirm REVIEW_TOKEN -f json
bycli csdn publish-article --status JOB_UUID -f json
```

review重新核对账号、素材摘要、正文及可见设置，确认码30分钟有效。最终提交前先持久化唯一attempt，再执行不重试的动作。已尝试的作业不能再次submit。HTTP或业务请求accepted表示已受理，后台精确记录published才表示已发布。

作业默认保存在`~/.bycli/publish-jobs/PLATFORM/JOB_UUID/job.json`，支持BYCLI_CONFIG_DIR。job_id是本地任务UUID；content-id是平台作品编号；account-id是公开创作者标识，CSDN使用账号名。不要用手机号、草稿编号或任务UUID代替作品编号。

结果未知时保留attempt与原回执，先查询后台核对，不自动重发。CSDN的`--recover JOB_UUID`仅在用户明确允许重新尝试且后台精确记录仍为草稿时建立关联任务；它保留原记录，本身不发布，仍需review及单独submit。掘金和CSDN的prepare `--resume`是准备失败恢复，不是发布重试。其他入口没有统一recover参数。

清单说明：[视频](../advanced/video-publish-prepare.md)、[小红书图文](../advanced/image-publish-prepare.md)、[搜狐图集和文章](../advanced/sohu-content-prepare.md)、[掘金文章](../advanced/juejin-article-prepare.md)、[CSDN文章](../advanced/csdn-article-prepare.md)。平台未支持的字段会报错，不静默忽略。

## 数据口径和缺失值

```bash
bycli csdn stats --content-id ARTICLE_ID --account-id PUBLIC_AUTHOR --type article --scope content -f json
```

| 平台 | 单篇范围 | 缺失与口径说明 |
|---|---|---|
| 小红书 | 当前笔记详情展示值 | 图文保留后台“观看数”标签；低数据量时占位符为null；图文不包含视频完播率和2秒退出率 |
| 搜狐号 | 当前发布日期筛选内内容的累计统计 | 筛选范围不是期间新增量；图文访问不当作独立访客；收藏未提供 |
| 掘金 | 单篇分析列表累计值 | 与顶部昨日整体概览分开；分享未提供 |
| CSDN | 单篇抽屉发布至今总数据 | 与下方趋势日期分开；分享明细不是分享次数；模型缺字段而页面默认0时返回null/model_missing |

数据保留rawLabel、rawValue、value、availability、precision及适用的unit。真实0与缺失null分别表示；collectedAt是采集时刻，dataAsOf为null表示平台没有提供精确更新时间。公开页面验证访问也可能增加阅读。

查询受当前已加载第一页或平台默认发布日期范围限制；未命中报错，不推断删除或返回全0。账号、精确作品编号、内容类型、可见指标或模型不能核对时停止。已有编辑器时保留现场，不新开同租约页面绕过保护。详情见[搜狐数据](../advanced/sohu-content-stats.md)、[掘金发布与数据](../advanced/juejin-article-publish-stats.md)和[CSDN数据](../advanced/csdn-article-stats.md)。

## 验证范围

七种平台内容组合已有授权发布样本，并完成所属后台状态与单篇数据只读验证。小红书两条历史原回执未知的记录保留原值，发布事实由独立后台核对确认。小红书新增回执兼容分支以单元测试为证，未为取样额外发帖；搜狐图集和文章的新CLI合法提交分支以本地测试为证，既有原生实发作为独立证据。

通用CDP网络捕获在一处本机环境曾阻塞Worker。CSDN采用当前页定向XHR/fetch观察器，已取得真实发布回执；不将这项适配描述为通用捕获问题全部解决。

账号绑定的实验脚本、截图、草稿内容和媒体保留在操作者本地，不随npm包分发。正常使用或验证发布时仍须针对新内容重新确认；历史授权不适用于新的作品。

## 微博头条和知识库扩展

微博、头条的新增命令使用各自的参数与确认流程，不套用本文四平台的job/review协议。微博长文章入口只保存草稿；图文和视频以及头条发布入口默认预检，显式 `--execute` 才执行。旧 `weibo publish` 会直接执行发布，使用前仍须确认具体内容。

完整参数、统计口径与边界见[微博](../adapters/browser/weibo.md)、[今日头条](../adapters/browser/toutiao.md)和[ima知识库状态](../adapters/browser/ima.md#status)。


## 搜狐号关键词检索

`bycli sohu search "关键词" --type article|video|gallery --status published|all|draft`检索当前登录账号的标题；`bycli sohu search-public "关键词" --limit 15`检索搜狐综合公开索引。账号结果绑定精确ID和所属账号；公开结果剔除平台回退推荐，不保证全量收录，也不提供未经验证的公开类型筛选。详见[搜狐号账号检索与公开检索](../advanced/sohu-search.md)。
