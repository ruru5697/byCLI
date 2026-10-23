# 搜狐四项修复本地验证

日期：2026-10-22。范围仅为线上会话“下载搜狐号视频我的大脑卡在99%”反馈的四项连接器问题。

## 实现范围

1. 下载器保留旧`.place_video`及匹配的全局播放器，新增`#mainVideoContent / #sohuPlayer`内视频和组件身份支持。正文容器内排除推荐/广告；规范化MP4链接核对视频ID、作者ID；多个不同正文视频明确拒绝歧义。保持域限制、HLS拒绝和原有下载校验。
2. 分类从当前视频或图集编辑器分别读取，精确标记目标并滚动后点击、回读。清单允许省略分类，素材准备后返回`category_required`；`--resume JOB --category JSON`使用上传后检查点恢复，复核素材、账号、字段，不导航或重传。旧版失败作业没有检查点时不自动迁移。
3. 文章/图集新增`--save-draft`、`--draft-status`、`--open-draft`。保存前复核，先落盘attempt，使用`nativeClickOnce`向精确命中的“存草稿”发送一次手势。只有精确所属草稿记录与重新打开后的内容校验都成功才记为`draft_saved`。不确定结果保留`draft_save_unknown`，已验证保存的重复请求返回同一ID，未知保存的重复请求被拒绝，状态核对不重复点击，也不丢弃之后的编辑。
4. 新增`sohu editor`，与发布及stats同一持久适配器作用域。可列出编辑器与关联作业、聚焦页签、发现分类，或用`--close PAGE --discard`明确放弃并精确关闭。验证页签消失后更新本地绑定、使review失效；远端草稿ID和已有发布attempt/receipt不被清除。查询守卫提供准确的查看/关闭命令。

## 常用命令

```bash
# 列出、查看或明确放弃编辑器
node dist/src/main.js sohu editor -f json
node dist/src/main.js sohu editor --open PAGE_ID
node dist/src/main.js sohu editor --close PAGE_ID --discard -f json

# 当前视频/图集编辑器的真实分类；primary会改变一级选中项
node dist/src/main.js sohu editor --categories -f json
node dist/src/main.js sohu editor --categories --primary 搞笑 -f json
node dist/src/main.js sohu publish-gallery --resume JOB_UUID --category '["搞笑","综合"]' -f json
node dist/src/main.js sohu publish-video --resume JOB_UUID --category '["科技","黑科技"]' -f json

# 保存、核对和重开文章/图集草稿
node dist/src/main.js sohu publish-article --save-draft JOB_UUID -f json
node dist/src/main.js sohu publish-gallery --save-draft JOB_UUID -f json
node dist/src/main.js sohu publish-gallery --draft-status JOB_UUID -f json
node dist/src/main.js sohu publish-gallery --open-draft JOB_UUID -f json
```

`open-draft`在旧编辑器已关闭后使用；若有编辑器，先保留或明确关闭它。恢复后重新review才能提交。`visibility: public`仍是内容配置，prepare/save-draft不因此发布。

## 本地验证记录

相关18文件607项回归通过；另补测小红书图文准备、图文提交和视频准备3文件76项通过。覆盖搜狐适配器、共享发布/数据逻辑、浏览器Page/BasePage、执行层、参数转换和扩展后台测试；构建、命令清单生成及diff空白检查通过。CLI帮助确认新参数可发现且字符串参数要求值。

```bash
npx vitest run --project adapter clis/sohu clis/_shared/video-prepare.test.js clis/_shared/video-stats.test.js clis/_shared/video-submit.test.js --project unit src/browser/page.test.ts src/browser/base-page.test.ts src/execution.test.ts src/commanderAdapter.test.ts --project extension extension/src/background.test.ts
npx vitest run --project adapter clis/xiaohongshu/publish-images.test.js clis/xiaohongshu/image-submit.test.js clis/xiaohongshu/publish-video.test.js
npm run build
git diff --check
```

覆盖新旧播放器、广告排除、媒体身份冲突、两类分类树隔离、视口外选项、视频/图集同作业恢复、保存前attempt落盘、原生手势仅一次、错误账号/类型/已发布状态拒绝、正文媒体替换拒绝、保存未知不重试、关闭后查询解除拦截和旧review失效。

## 验证边界

本轮只做本地验证，没有连接真实搜狐网站执行下载、上传、保存草稿或发布，没有修改线上测试会话、部署、提交Git或升级已安装扩展。

本地DOM模拟和状态机测试不能证明真实网站已恢复。保存响应兼容以同源save/draft端点明确成功ID作为候选，仍需真实站点响应取样；未识别响应不判成功。管理列表仍只检查当前加载页。重开后媒体URL、编辑器模型或字段不兼容会保留未验证状态，不按标题或草稿计数猜测。视频可靠远端草稿保存未实现，继续明确为实时编辑器准备。

后续真实验收应串行覆盖：新旧样本下载；视频/图集各自分类；文章/图集保存后关闭重开；保留编辑器时查询被保护、明确关闭后查询成功，全程无需重启浏览器。
