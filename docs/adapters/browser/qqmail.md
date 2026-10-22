# QQ 邮箱

以下命令和参数对应当前 byCLI 命令清单。使用前可运行 `bycli qqmail <command> --help` 查看完整选项。

先在 Chrome 登录 QQ 邮箱网页版并连接 Browser Bridge。命令只读取邮件列表；默认收件箱，日期边界按本地时间解析。返回内容可能含私人邮件信息，请保存在自己的工作目录。

## `inbox`

QQ 邮箱邮件列表（默认收件箱，按时间倒序，支持日期过滤）

```bash
bycli qqmail inbox --help
```

| 参数 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `--limit` | 否 | 20 | 返回数量 (max 200) |
| `--folder` | 否 | inbox | 文件夹：inbox / sent / draft / trash / spam |
| `--since` | 否 |  | 起始日期（含），YYYY-MM-DD 或 "YYYY-MM-DD HH:MM" |
| `--until` | 否 |  | 截止日期（含），YYYY-MM-DD 或 "YYYY-MM-DD HH:MM" |
| `--date` | 否 |  | 只看某一天，YYYY-MM-DD（等价 since+until 同日） |

返回字段：`index`, `subject`, `fromNick`, `fromEmail`, `date`, `unread`, `sizeKb`, `digest`, `emailId`。可使用 `-f json` 保留结构化输出。
