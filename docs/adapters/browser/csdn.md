# CSDN

**Mode**: Browser · **Domain**: `editor.csdn.net` / `mp.csdn.net`

| 命令 | 用途 |
|---|---|
| `bycli csdn search QUERY` | 搜索技术文章 |
| `bycli csdn publish-article --prepare --input article.json` | 准备Markdown、标签、裁剪封面、声明，保存并重开草稿 |
| `bycli csdn publish-article --review JOB_UUID` | 重新核对内容与设置，生成30分钟确认码 |
| `bycli csdn publish-article --submit JOB_UUID --confirm TOKEN` | 用户明确授权后的单次提交 |
| `bycli csdn publish-article --status JOB_UUID` | 回执与精确所属作品状态 |
| `bycli csdn publish-article --recover JOB_UUID` | 单独授权后为未知尝试建立关联恢复任务，本身不发布 |
| `bycli csdn stats --content-id ID --account-id PUBLIC_AUTHOR` | 发布至今累计数据及可用的附加指标 |

account-id使用公开账号名。prepare支持符合约束的`--resume`；已有attempt任务禁止直接重发，recover必须先确认后台精确记录仍为草稿。分享入口代表分享带来的阅读明细，不当作分享次数。模型缺字段且页面默认显示0时，返回null/model_missing并保留显示值。

详情：[准备与发布](../../advanced/csdn-article-prepare.md)、[单篇数据](../../advanced/csdn-article-stats.md)、[统一确认规则](../../guide/native-connectors.md)。
