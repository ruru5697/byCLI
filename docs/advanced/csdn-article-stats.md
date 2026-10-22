# CSDN单篇文章数据采集

`csdn stats`读取当前登录账号已发布文章的“发布至今总数据”，按精确文章编号与公开账号核对所属记录、管理行和累计卡片。

```bash
node dist/src/main.js csdn stats --content-id 123456789 --account-id csdn_demo_author --type article --scope content -f json
```

必须提供十进制字符串文章编号和CSDN公开账号名，只支持article/content。已有编辑页时返回EDITOR_IN_USE，保留稿件；未知受控页面返回PAGE_IN_USE。命令只搜索当前管理列表第一页，未命中返回CONTENT_NOT_FOUND，不按标题猜测，不推断删除或补0。

`metrics`包含impressions、reads、comments、likes、favorites、followers及shares；`extraMetrics`包含qualityScore、promotionCardClicks、outlinkClicks、finishedReads和interactionDepth。每项提供原始标签、显示值、value、availability和precision。真实0为available/exact；模型缺字段时即使网站显示0，也返回null/model_missing及displayedValue；平台占位符保持null。质量分单位为score。

“读者分享”入口为分享带来的阅读明细，不是分享次数；shares返回null/not_exposed，命令不下载明细。下方日期范围属于趋势查询，不混入累计范围；dataAsOf为null，collectedAt只表示本次读取时间。展现量每日更新，阅读可能包含此前公开页验证访问。

通过Vue3根VNode绑定精确可见文章记录，核对工具栏账号、文章编号、标题、公开链接及已发布状态，再打开该记录的正常“数据”抽屉。完成的单篇请求、抽屉标题/发布时间/累计标签及分享入口身份必须匹配；六项累计值核对模型，四项互动再核对管理行。重复标签、缩写精度不足、数值不符及身份变化均停止，不返回误配的数据。

使用原生Page操作与安全字段快照，不启动通用网络捕获、不发布或上传、不刷新质量分、不持久化cookie或认证头。实际样本、后台截图和保护验证见[原生连接器使用与验证范围](../guide/native-connectors.md)。
