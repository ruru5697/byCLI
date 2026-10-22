# 掘金文章提交、状态与数据

准备格式见[文章准备说明](juejin-article-prepare.md)。当前原生命令支持prepare、review、submit、status，以及按精确文章ID采集单篇分析数据。最终提交需要人对具体候选的发布授权；prepare验收或自动生成的review确认码不代替授权。

```bash
node dist/src/main.js juejin publish-article --review JOB_UUID -f json
node dist/src/main.js juejin publish-article --submit JOB_UUID --confirm CURRENT_TOKEN -f json
node dist/src/main.js juejin publish-article --status JOB_UUID -f json
node dist/src/main.js juejin stats --content-id ARTICLE_ID --account-id OWNER_ID -f json
```

## 发布边界

review恢复同一已保存草稿，核对预期账号、草稿ID、完整正文、标题、摘要、分类、标签、封面绑定、空专栏/话题和组织同步设置；核对本地封面字节及清单摘要，并生成30分钟确认码。已占用的未知页面、其他编辑器不会被替换。已知只读文章管理页和系统通知页可以恢复到指定已保存草稿。

submit再次核对清单、素材和实时设置，要求当前未过期的准确确认码。响应捕获准备完成后先把唯一attempt写入私有报告，再通过evaluateOnce执行一次最终按钮操作，通信层不重试。执行现场记录checked/dispatching/dispatched或preflight_failed；传输异常不等同于未执行。

捕获仅信任`https://api.juejin.cn/content_api/v1/article/publish`的POST完整响应，明确`err_no=0`表示受理，非零表示业务拒绝。文章ID保留原始数字字符串，禁止从不安全的JavaScript大整数恢复。受理不等于审核通过。缺失、截断、矛盾或无法确认的响应保持result_unknown；HTTP成功不单独作为业务成功证据。

已有attempt的任务始终返回ALREADY_ATTEMPTED，不会自动复核或再次提交。出现未知结果先检查后台，不删除或重置原记录。本轮首次异常后检查到后台文章为0、草稿保留且未记录发布请求，用户明确允许再试一次，才建立关联的恢复任务；首轮未知作业保留，恢复任务独立留痕。此人工事故处理不作为CLI的自动重试入口。

## 状态查询

status只认回执或有明确来源的核对记录中的精确文章ID，核对账号与原草稿ID、标题和规范公开链接。文章管理页的记录可能在NuxtLink完成挂载后改变组件层级，因此读取其拥有文章数据的父组件，而不是依赖临时的link根组件属性。缺少绑定身份时显式报错，不将其错误输出为not_found。

按平台前端实际枚举检查审核状态：-1未通过、0未审核、1审核中、2通过、3编辑更新中。只有审核通过、作品状态为公开发布/推荐且visible_level=0时报告published并提供公开链接；未知组合返回query_unavailable。删除状态单列，不能由列表未命中推断删除。

查询只检查当前已加载第一页。不存在或超出当前范围的ID返回not_found，不能据此断言作品不存在。它等待正常列表响应完成及列表加载结束，避免把骨架页当成空结果。查询遇编辑器返回EDITOR_IN_USE，不新开替代页绕过保护；关闭查询页后可在同一持久会话恢复。

## 单篇数据口径

stats使用创作者中心“内容数据 → 文章数据 → 单篇分析”表，检查当前账号，并以Vue行VNode的精确article_id绑定DOM行，核对模型内文章ID、用户ID、标题及表头。不会靠同名标题或行号认领作品。

| 字段 | 后台标签 | 口径 |
| --- | --- | --- |
| impressions | 展现数 | 当前单篇累计 |
| reads | 阅读数 | 当前单篇累计 |
| likes | 点赞数 | 当前单篇累计 |
| comments | 评论数 | 当前单篇累计 |
| favorites | 收藏数 | 当前单篇累计 |
| shares | 分享数 | 该表及详情趋势未提供，null/not_exposed |

五个可见值必须与模型一致，0保留为真实0。缺失、占位、无法解析或取整缩写不能冒充精确值；与模型不一致时停止。`dataAsOf=null`表示后台未提供统一精确更新时间。

页面顶部“某日 数据表现”属于整体概览，与单篇列表不是同一口径。本轮顶部日期为2026-10-19，但新稿2026-10-20的单篇行已经有阅读1，因此不会把昨日概览0覆盖到新文章。输出单列overviewDate，period明确content_cumulative，不解释为最近7天新增量。

仅支持article/content、当前第一页，账号ID和文章ID必须显式提供。未命中或账号不符报错，不构造0指标；不支持分享数、粉丝增量、阅读时长、导出或翻页。公开页面验收本身可能贡献一次阅读，不能把阅读1描述成已获得自然流量。

本机账号绑定的验收素材、回执和实验脚本不随包分发。可用性与验证范围见[原生连接器说明](../guide/native-connectors.md)。
