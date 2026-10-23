import { USER_CONFIRMED_ARG } from '../_shared/publish-confirmation.js';
import { cli, Strategy } from '@sovovs/bycli/registry';
import { publishVideo, validatePublishArgs, PUBLISH_COLUMNS } from './_shared/publish.js';
import { editorSessionPage } from './_shared/editor-session.js';

export const videoPublishCommand = cli({
  site: 'weixin-channels', name: 'video-publish', access: 'write',
  domain: 'channels.weixin.qq.com', strategy: Strategy.UI, browser: true, navigateBefore: false,
  siteSession: 'persistent',
  description: '先上传并保存、重开核对平台草稿；上层获得用户确认后才以 submit --user-confirmed 单次提交',
  validateArgs: validatePublishArgs,
  args: [
    { name: 'file', positional: true, help: '本地视频文件（prepare / retry-upload 模式必填）' },
    { name: 'description', help: '完整视频描述（prepare / adopt-draft 必填）' },
    { name: 'cover', help: 'prepare 可选：分享卡片横封面（4:3），本地 PNG/JPEG；不传保留默认' },
    { name: 'vertical-cover', help: 'prepare 可选：个人主页竖封面（3:4），本地 PNG/JPEG；不传保留默认' },
    { name: 'cover-confirmed', choices: ['horizontal', 'vertical'], help: '仅 resume：用户已手动确认指定封面；只读核对该卡片后继续其余封面并保存原草稿，不重复点击或上传已完成封面' },
    { name: 'reopen-saved-draft', type: 'boolean', help: '仅配合 resume --resume-cover-opening：原页已失效且尚未上传任何封面时，按原草稿 ID 重开并严格核对后继续，不重传视频' },
    { name: 'resume-cover-opening', choices: ['horizontal', 'vertical'], help: '仅 resume：原弹窗已打开但尚未上传图片时，核对原草稿和两张卡片后原地继续；不重开、不重传视频、不重试未知上传' },
    { name: 'retry-cover-processing', choices: ['horizontal', 'vertical'], help: '仅 resume：核对原页明确的画布尺寸为零错误后，有界恢复该封面；不重传视频、不重试未知点击或保存' },
    { name: 'ai-generated', choices: ['yes', 'no'], help: '如实选择是否含 AI 生成内容（prepare / adopt-draft 必填）' },
    { name: 'operation', required: true, help: '本地操作记录 JSON 路径，父目录须存在；同一条内容始终复用' },
    { name: 'mode', default: 'prepare', choices: ['prepare', 'adopt-draft', 'retry-upload', 'recover', 'resume', 'submit'], help: 'prepare 上传并保存核对草稿；adopt-draft 核验现有草稿；retry-upload 空页重传；recover 核验重启预览；resume 恢复或重开已保存草稿；submit 用户确认后提交' },
    { name: 'draft-id', help: 'adopt-draft 专用：草稿箱卡片对应的精确 export/... ID' },
    { name: 'editor-page', help: 'adopt-draft / recover / retry-upload：明确检查过的 Chrome 编辑页 ID' },
    { name: 'editor-session', help: 'adopt-draft / recover / retry-upload：已通过 browser <session> bind 明确绑定的浏览器会话' },
    { name: 'retry-cover-upload', choices: ['horizontal', 'vertical'], help: 'resume 专用：仅记录证明未注入文件时允许该封面重试一次' },
    { name: 'timeout', type: 'int', default: 180, help: '整次操作预算秒数（1–1800）；超时保留草稿与当前阶段' },
    USER_CONFIRMED_ARG,
    { name: 'execute', type: 'boolean', help: '执行当前操作；提交另需 --mode submit' },
  ],
  columns: PUBLISH_COLUMNS,
  func: async (page, args) => publishVideo(await editorSessionPage(page, args), args),
});
