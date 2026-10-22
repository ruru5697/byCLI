# 搜狐号

**Mode**: Browser · **Domain**: `mp.sohu.com` / `www.sohu.com`

| 命令 | 用途 |
|---|---|
| `bycli sohu download URL` | 下载可访问的搜狐号文章正文视频并验证MP4 |
| `bycli sohu publish-video` | 视频prepare、review、单次submit及status |
| `bycli sohu publish-gallery` | 图集prepare、review、单次submit及status |
| `bycli sohu publish-article` | 文章prepare、review、单次submit及status |
| `bycli sohu stats --type video` | 视频单篇累计数据 |
| `bycli sohu stats --type gallery` | 图集单篇累计数据 |
| `bycli sohu stats --type article` | 文章单篇累计数据 |

发布需Chrome登录、明确内容清单、当前review确认码及用户对该内容的授权。未知结果保留attempt，不自动重发。数据命令使用`--content-id ID --account-id PUBLIC_ID --scope content -f json`，按精确账号、作品编号和内容类型核对；收藏未提供为null。默认日期筛选为内容发布日期范围，不代表期间新增量。

详情：[原生连接器流程](../../guide/native-connectors.md)、[视频准备](../../advanced/video-publish-prepare.md)、[图集和文章](../../advanced/sohu-content-prepare.md)、[统计口径](../../advanced/sohu-content-stats.md)。
