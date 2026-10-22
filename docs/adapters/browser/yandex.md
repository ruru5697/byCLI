# Yandex 搜索

以下命令和参数对应当前 byCLI 命令清单。使用前可运行 `bycli yandex <command> --help` 查看完整选项。

需要 Chrome 与 Browser Bridge。遇到登录、验证码或访问限制时，先在浏览器完成平台提示，再重试；搜索无结果会明确报错。

## `search`

Search Yandex

```bash
bycli yandex search <keyword> --help
```

| 参数 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `keyword` | 是 | — | Search query |
| `--limit` | 否 | 10 | Number of results (1-50) |
| `--page` | 否 | 1 | Result page number |
| `--lr` | 否 | — | Yandex region code |
| `--lang` | 否 | — | Language code |
| `--sort` | 否 | — | Sort order: relevance or date |

返回字段：`rank`, `title`, `url`, `snippet`, `displayUrl`, `source`, `resultType`, `author`, `publishedAt`, `score`, `extra`。可使用 `-f json` 保留结构化输出。
