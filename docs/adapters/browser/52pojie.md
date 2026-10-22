# 吾爱破解

以下命令和参数对应当前 byCLI 命令清单。使用前可运行 `bycli 52pojie <command> --help` 查看完整选项。

需要 Chrome 与 Browser Bridge。遇到登录、验证码或访问限制时，先在浏览器完成平台提示，再重试；搜索无结果会明确报错。

## `search`

Search 52pojie

```bash
bycli 52pojie search <keyword> --help
```

| 参数 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `keyword` | 是 | — | Search query |
| `--limit` | 否 | 10 | Number of threads (1-50) |
| `--page` | 否 | 1 | Result page number |
| `--section` | 否 | — | Forum section identifier |
| `--sort` | 否 | — | Sort order: relevance, latest, replies, views |

返回字段：`rank`, `title`, `url`, `snippet`, `displayUrl`, `source`, `resultType`, `author`, `publishedAt`, `score`, `extra`。可使用 `-f json` 保留结构化输出。
