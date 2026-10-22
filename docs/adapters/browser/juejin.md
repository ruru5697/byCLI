# 掘金

**Mode**: Browser · **Domain**: `juejin.cn`

| 命令 | 用途 |
|---|---|
| `bycli juejin search QUERY` | 搜索文章 |
| `bycli juejin publish-article --prepare --input article.json` | 准备并保存Markdown文章、封面和发布设置 |
| `bycli juejin publish-article --review JOB_UUID` | 复核同一草稿，生成30分钟确认码 |
| `bycli juejin publish-article --submit JOB_UUID --confirm TOKEN` | 用户明确授权后的单次提交 |
| `bycli juejin publish-article --status JOB_UUID` | 回执及精确所属作品状态 |
| `bycli juejin stats --content-id ID --account-id PUBLIC_ID` | 单篇累计展现、阅读、点赞、评论和收藏 |

分享未提供为null；顶部整体概览不覆盖单篇累计值。查询限当前加载第一页，未命中报错；编辑器存在时保留现场。`--resume`仅恢复符合约束的准备失败，不清除发布attempt。

详情：[准备清单](../../advanced/juejin-article-prepare.md)、[发布与统计](../../advanced/juejin-article-publish-stats.md)、[统一确认规则](../../guide/native-connectors.md)。
