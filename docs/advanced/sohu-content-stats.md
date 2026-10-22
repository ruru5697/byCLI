# 搜狐号单篇内容数据采集

原生 `sohu stats` 支持视频、图集和文章，只读取登录账号后台，不发布、不上传。默认type仍为video，保持原有视频调用方式。

```bash
node dist/src/main.js sohu stats --type gallery --content-id 123456001 --account-id 123456789 -f json
node dist/src/main.js sohu stats --type article --content-id 123456002 --account-id 123456789 -f json
node dist/src/main.js sohu stats --content-id 123456003 --account-id 123456789 -f json
```

`--content-id`必须为精确作品编号，`--account-id`建议始终提供；scope只支持content。总体命令超时默认为180秒，可用 `--timeout 240` 调整。现有文章/图集/视频编辑页会受到保护，不替换编辑器或新开同租约标签。

## 来源与内容隔离

命令进入“内容分析 → 单篇”。图集和文章共用“图文”筛选，其正常签名GET请求 `/mpbp/bp/news/v4/users/stat/single/list` 的type=1，但记录本身分别为type=3图集、type=2文章；视频筛选type=2、记录type=4。命令同时核对请求类型、当前账号、精确ID和记录类型，不能用同名作品或相邻行代替。

账号在选择筛选前、响应读取后、可见表格核对后分别检查。浏览器中只观察平台正常请求，不绕过签名直连。响应只在内存中处理，输出必要字段；不保存Cookie、凭证、原始响应或完整签名地址。

可见行通过平台行模型的newsId绑定精确ID及类型，列通过唯一表头标签绑定，逐项对照响应与DOM。表头缺失/重复、数值或精度不一致、同ID多结果均明确失败，不输出看似完整的数据。

## 输出字段与口径

| 图集/文章字段 | 后台原标签 | 含义 |
| --- | --- | --- |
| reads | 阅读数 | 按后台当前值输出 |
| visits | 访问（播放）数 | 图文场景保留该原始标签，不解释为独立访客数或视频播放量 |
| likes | 点赞数 | 按后台当前值输出 |
| comments | 评论数 | 按后台当前值输出 |
| shares | 分享数 | 按后台当前值输出 |
| votes | 投票数 | 按后台当前值输出 |
| favorites | 收藏数 | 本表未提供，value=null、reason=not_exposed |

视频仍输出plays对应“访问（播放）数”，不改为visits。每项保留rawLabel、rawValue、value、availability和precision；实际0保持0，平台占位值为null，不把未提供字段补成0。无法精确对齐响应和显示缩写时明确失败，不把近似数伪装成精确数。

输出还包括账号、精确ID、contentType、标题、平台给出的发布日期、采集时间、来源筛选类型与记录类型。`dataAsOf=null`：虽然后台标注“实时”，没有统一精确更新时间，不用采集时间冒充平台更新时间。

当前页面的日期条件是**发布日期筛选**，返回这些内容的当前累计统计，不是所选日期内的新增量。period保留实际start/end。当前仅读取默认范围的第一页，未命中返回CONTENT_NOT_IN_RANGE，类型错误返回CONTENT_TYPE_UNVERIFIED；不将缺失当成0或删除。尚未提供自定义日期、批量翻页、趋势导出、曝光数据或收藏来源补采。

## 实测与复验

本机账号绑定的验收素材、回执和实验脚本不随包分发。可用性与验证范围见[原生连接器说明](../guide/native-connectors.md)。


脚本固定使用上述三条已发布作品，保存命令输出、后台记录、对照表与截图，并关闭自己的管理/分析页；不上传、不新增发布。数据可能变化，以每次采集时刻为准。
