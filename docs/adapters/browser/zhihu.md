# Zhihu

发布前必须先保存、重开核对平台草稿，向用户展示具体内容并获得明确确认；然后单独调用 `--mode submit --execute --user-confirmed`。准备阶段不得预先传入确认参数。详见[三平台发布确认流程](../../guide/publishing-confirmation.md)。

**Mode**: 🔐 Browser · **Domain**: `zhihu.com`

## Commands

| Command | Description |
|---------|-------------|
| `bycli zhihu hot` | Read Zhihu hot topics |
| `bycli zhihu recommend` | Read Zhihu home recommendations |
| `bycli zhihu waiting` | List questions from 写回答 / 等你来答 by category |
| `bycli zhihu search` | Search Zhihu content |
| `bycli zhihu question` | Read question answers by question ID |
| `bycli zhihu answer-detail <id>` | Read one full answer by answer ID, typed target, or answer URL |
| `bycli zhihu answer-comments <id>` | Read flattened comments for one answer |
| `bycli zhihu collections` | List your Zhihu favorite collections |
| `bycli zhihu collection <collection_id>` | List content from a Zhihu favorite collection |
| `bycli zhihu download` | Export a Zhihu article to Markdown |
| `bycli zhihu follow <target> --execute` | Follow a user or question |
| `bycli zhihu like <target> --execute` | Like an answer or article |
| `bycli zhihu favorite <target> (--collection <name> \| --collection-id <id>) --execute` | Favorite an answer or article into a specific collection |
| `bycli zhihu comment <target> (<text> \| --file <path>) --execute` | Create a top-level comment when a fresh top-level editor is already present |
| `bycli zhihu answer-waiting-draft <target> (<text> \| --file <path>) --execute` | Save a new answer draft or an existing answer’s unpublished edit draft |
| `bycli zhihu answer <target>` | Direct publication disabled; use `answer-submit` to save a draft, then obtain user confirmation |
| `bycli zhihu article-draft` | Create and reopen a persistent article draft with ordered images and an optional cover |
| `bycli zhihu article-publish` | Reopen/resume an article draft or explicitly submit its existing operation once |
| `bycli zhihu video-draft` | Upload a video, identify its actual draft type and reopen the exact draft |
| `bycli zhihu video-publish` | Reopen or explicitly submit the verified video draft once |
| `bycli zhihu answer-submit` | Prepare/reopen a new answer draft with an AI declaration, then explicitly submit once |
| `bycli zhihu content-status` | Read a local journal or reconcile exact creator identity and public content |
| `bycli zhihu content-stats` | Read creator aggregate and daily statistics for article/answer/pin/zvideo |

## Target Formats

- Question: `question:123456` or `https://www.zhihu.com/question/123456`
- Answer: `answer:123456:789012` or `https://www.zhihu.com/question/123456/answer/789012`
- Article: `article:998877` or `https://zhuanlan.zhihu.com/p/998877`
- User: `user:alice` or `https://www.zhihu.com/people/alice`

## Write Safety Notes

- All write commands require `--execute`
- `favorite` requires exactly one of `--collection` or `--collection-id`
- `favorite` only supports existing collections, it does not create new collections
- `comment` only supports top-level comments
- `comment` currently requires the page to already expose a fresh top-level comment editor
- `comment` and `answer` also support `--file <path>` for multi-line payloads
- Article targets can live on `zhuanlan.zhihu.com`, while question and answer targets stay on `www.zhihu.com`

## Usage Examples

```bash
# Read flows
bycli zhihu hot --limit 5
bycli zhihu recommend --limit 20
bycli zhihu waiting --limit 20
bycli zhihu waiting --type invited --limit 20
bycli zhihu waiting --type latest --limit 40 -f json
bycli zhihu waiting --type hot --limit 20
bycli zhihu search codex --type answer --limit 20
bycli zhihu search "Claude Code vs Codex?" --type all --limit 20
bycli zhihu question 123456 --limit 3
bycli zhihu answer-detail answer:123456:789012
bycli zhihu answer-detail "https://www.zhihu.com/question/123456/answer/789012" --max-content 2000
bycli zhihu answer-comments answer:123456:789012 --limit 20 --replies-limit 3
bycli zhihu collections --limit 20
bycli zhihu collection 83283292 --limit 20
bycli zhihu download "https://zhuanlan.zhihu.com/p/998877" --download-images

# Write flows
bycli zhihu follow question:123456 --execute
bycli zhihu follow user:alice --execute
bycli zhihu like answer:123456:789012 --execute
bycli zhihu like article:998877 --execute
bycli zhihu favorite article:998877 --collection "默认收藏夹" --execute
bycli zhihu favorite answer:123456:789012 --collection-id fav-b --execute
bycli zhihu comment answer:123456:789012 --file ./comment.txt --execute
# Direct answer publishing is disabled; use answer-submit to prepare a draft first.

# JSON output
bycli zhihu hot -f json
```

## Waiting Questions

- `waiting` reads `https://www.zhihu.com/question/waiting` using your logged-in browser session.
- `--type` supports `recommend` (为你推荐, default), `invited` (邀请回答), `latest` (最新问题), and `hot` (人气问题). It preserves the selected list’s displayed order.
- Invitation cards do not display views, so `views` is `null` for those rows.
- Returns `rank`, `id`, `title`, `views`, `answers`, `followers`, and `url`; question IDs are strings so long IDs retain their precision.
- `--limit` defaults to 20 and accepts 1–1000. The command scrolls to load more, removes duplicate questions, and may return fewer rows when the page stops producing new questions.
- Counts reflect the displayed page (rounded 万/亿 counts are expanded); unavailable counts are `null`.
- This is read-only: it does not open an answer editor or publish an answer.

## Search Notes

- Quote queries that contain spaces or shell-special characters, for example `bycli zhihu search "Claude Code vs Codex?"`
- `search --type` supports `all`, `answer`, `article`, and `question`
- `search --limit` supports up to 1000 results, but normal-sized requests are recommended

## Answer Waiting Drafts

`answer-waiting-draft` opens the question, detects whether you already have an answer, and saves through the web editor. It never clicks **发布回答** or **提交修改**. After saving it reopens the editor and checks that the complete text was persisted.

```bash
# Preview the resolved input; no browser connection or write
bycli zhihu answer-waiting-draft 2077824745589028563 --file ./answer.txt --dry-run -f json

# Automatically choose a new answer draft or your existing answer’s edit draft
bycli zhihu answer-waiting-draft 2077824745589028563 --file ./answer.txt --execute

# Explicitly replace the existing editor contents (including formatting)
bycli zhihu answer-waiting-draft question:2077824745589028563 --file ./answer.txt --mode edit --existing replace --execute

# Append text, preserve existing content, and keep the editor tab open
bycli zhihu answer-waiting-draft 2077824745589028563 "补充观点" --existing append --close-editor false --keep-tab true --execute

# Target your own answer URL or answer:<questionId>:<answerId>
bycli zhihu answer-waiting-draft answer:2077824745589028563:2085034727166292329 --file ./answer.txt --existing replace --execute -f json
```

| Parameter | Default | Behavior |
|-----------|---------|----------|
| `<target>` | Required | Numeric question ID, `question:<id>`, question URL (including `#write`), your answer URL, or `answer:<questionId>:<answerId>` |
| `[text]` / `--file` | One required | Plain text or a UTF-8 file; mutually exclusive. Markdown/HTML files are inserted as literal text, not rendered markup |
| `--mode` | `auto` | `auto` detects new/edit; `new` refuses an existing published answer; `edit` requires an existing answer you can edit |
| `--existing` | `error` | `error` protects existing content; `replace` replaces it; `append` / `prepend` insert at the end/start while retaining existing content. Identical full text is unchanged |
| `--separator` | Blank line | Literal separator between old and inserted content for append/prepend |
| `--prefix` / `--suffix` | Empty | Literal text placed before/after the supplied body; include any desired newline yourself |
| `--expected-title` | Unset | Require the exact question title before editing |
| `--timeout` | `30` | Total wait budget for editor/save verification, in seconds, from 1 to 120 |
| `--close-editor` | `true` | Close the verified editor; use `false` with the common `--keep-tab true` option to leave it available |
| `--dry-run` | `false` | Local input preview; does not inspect current online content or simulate merging with an existing draft |
| `--execute` | `false` | Required for actual saving; mutually exclusive with `--dry-run` |

- Content is limited to 50,000 characters, including prefixes, suffixes and merged existing text.
- The result includes `question_id`, `answer_id` (empty for a new draft), `mode`, `url`, `characters`, `verified`, `published: false`, and `editor_open`.
- `outcome` is `saved` or `unchanged`; a draft already containing the exact requested text is verified without reinserting it.
- Saving an edit draft leaves the published answer unchanged. It appears as **有未发布的编辑草稿** on Zhihu.
- A save or verification error may leave a partially saved draft. Inspect it before retrying, especially with append/prepend.

## Comment Notes

- `answer-comments --limit` counts top-level comments
- `answer-comments --replies-limit` expands up to that many replies per top-level comment
- Comment rows are flattened in Zhihu order. Zhihu's comments API does not expose stable parent comment ids here, so `parent_id` stays empty and `depth` does not claim nested-thread evidence; use `reply_to`, `comment_rank`, and `reply_rank` only as display hints within the flat stream.

## Prerequisites

- Chrome running and **logged into** zhihu.com
- [Browser Bridge extension](/guide/browser-bridge) installed
- A logged-in Zhihu session that can access both `www.zhihu.com` and `zhuanlan.zhihu.com`


## Creator publishing lifecycle

The new publishing commands use the normal Browser Bridge and the existing answer draft helper. Preparation saves an **unpublished** platform draft and reloads it. Submission is a separate explicit action using the same local operation file. All IDs remain strings. A video uploaded through Zhihu may become a `pin`; the adapter reads the actual type instead of assuming `zvideo`.

```bash
mkdir -p ./operations

# Plain text with paragraph boundaries; images are appended sequentially in this order.
bycli zhihu article-draft --title "工作笔记" --file ./article.txt \
  --images '["./first.png","./second.png"]' --cover ./cover.png \
  --ai-generated yes --operation ./operations/article.json --execute --keep-tab true

# Reopen an identified draft after closing/restarting the browser; does not reupload.
bycli zhihu article-publish --operation ./operations/article.json --mode reopen --execute --keep-tab true

# Only this explicit stage attempts public submission. Run after reviewing the draft.
bycli zhihu article-publish --operation ./operations/article.json --mode submit --user-confirmed --execute

bycli zhihu video-draft ./video.mp4 --title "视频标题" --file ./caption.txt \
  --ai-generated yes --original no --category 其他 \
  --operation ./operations/video.json --execute --timeout 300 --keep-tab true
bycli zhihu video-publish --operation ./operations/video.json --mode reopen --execute --keep-tab true
# Explicit public submission, after review:
bycli zhihu video-publish --operation ./operations/video.json --mode submit --user-confirmed --execute

# New answers only; an existing/deleted answer or a different existing draft is protected.
bycli zhihu answer-submit question:123456 --file ./answer.txt --ai-generated yes \
  --expected-title "问题的准确标题" --operation ./operations/answer.json --execute --keep-tab true
bycli zhihu answer-submit --operation ./operations/answer.json --mode reopen --execute --keep-tab true
# Explicit public submission, after review:
bycli zhihu answer-submit --operation ./operations/answer.json --mode submit --user-confirmed --execute

# Local status needs no browser. Remote status requires an exact target.
bycli zhihu content-status --operation ./operations/article.json -f json
bycli zhihu content-status --operation ./operations/article.json --target article:998877 -f json
```

The journal is atomically written with mode `0600` and locked during each operation. Preserve it, including after errors. `submit_unknown` is recorded **before** clicking publish; repeating a submit command does not click again. `submitted` means the platform receipt/UI confirmed submission; `public_confirmed` additionally requires an exact creator identity and matching public content. Public-page verification uses the current logged-in session; it does not establish anonymous visibility or a permanent moderation decision. An explicitly abnormal creator content mark prevents public confirmation. Moderation/deletion may later make content unavailable; the adapter never republishes it automatically. Account identity, content, draft ID, visible declaration and enabled publish control are checked before submission.

Article paragraphs are inserted as plain text; Markdown/HTML semantic formatting is not promised. Images upload one at a time, then resource IDs/order are compared on reload. The cover is compared by resource ID because Zhihu rewrites image sizes/URLs. The article editor can remain at “草稿保存中” and does not persist its AI declaration with the draft. Article persistence is therefore checked against the actual editor draft GET response (exact ID, owner, draft state, body, ordered image IDs and cover), both on reopen and immediately before submission: `reopen` first verifies persisted content, then configures the declaration again; `submit` rechecks it. Video uses its generated cover, requires an explicit originality choice and an exact category label. Custom video covers and additional video marks are not exposed by these commands.

`article-publish --mode repair-cover` explicitly retries a missing cover on the same identified unpublished article. It checks account, server body/image identity and the original local cover hash first, uploads once per invocation, and then verifies the server cover. It never recreates or publishes the article.

`article-publish --mode resume` resumes an interrupted preparation only in its bound, unchanged editor without another upload. The optional `--repair-images` rebuilds images in the same unpublished draft after verifying account, full body, current image identities and local file hashes; it is not automatic. If the tab was lost but a precise draft ID was recorded, use `reopen`. An unidentified/interrupted upload is retained for manual inspection rather than repeated. A crash may leave a `.lock` file; inspect the operation before manually removing a stale lock.

### Draft wait diagnostics

`--timeout` remains a per-step limit, so uploads may use a longer limit without making a stable content mismatch wait for the entire period. Once a draft is loaded, its images are ready and the page reports it saved, unchanged conflicting title/body/image/cover fields fail verification after 5 seconds. A save-failure indication fails immediately. The known creator-to-editor navigation transition gets at most 5 seconds of grace; sign-in and unrelated pages are not accepted as loading editors.

Progress goes to stderr at each stage and every 15 seconds while waiting, including readiness, save state, draft ID and mismatched field names. JSON remains on stdout. To watch progress, redirect only stdout to a result file; combining streams with `2>&1 | tail -30` hides progress until the command finishes.

Failed verification clears `verified`, records `verification_error` in the existing operation journal, and retains any exact draft ID already observed in the native response. Inspect that same draft and resolve content differences before `video-publish --mode reopen`; the adapter does not overwrite conflicting content, reupload media or submit automatically.

## Creator statistics

```bash
bycli zhihu content-stats article:998877 --days 7 -f json
bycli zhihu content-stats answer:123456:789012 --days 14 -f json
bycli zhihu content-stats https://www.zhihu.com/pin/998877 --days 7 -f json
bycli zhihu content-stats 998877 --type pin --start-date 2026-10-13 --end-date 2026-10-19 --aggregate period -f json
```

The default is a cumulative overview plus seven days of trend, including Shanghai today. `--aggregate period` restricts the overview to the specified dates. Explicit start/end dates must be paired, cannot be combined with `--days`, and span at most 366 days. Bare IDs require `--type`; a conflicting URL/type is rejected. A permission error never causes a retry with another content type.

`overview` and `trend` keep `views` (`pv`) separate from `plays` (`play`), and preserve upvotes, likes, collections, comments, shares, reposts and follows as distinct counters. Missing values are `null`, actual zeros remain `0`, and missing days are not filled. Rates ending in `_pct` use percentage points; `NaN%`/undetermined values become `null`. Malformed/unsafe counters, inconsistent content identity and duplicate/out-of-range dates fail explicitly. These are logged-in browser creator endpoints, not an official API credential integration.

Earlier implementation evidence: implementation report（本地实验记录，未随公开文档提供）. Subsequent article, pin and answer command publication, status and statistics evidence is recorded in remaining validation（本地实验记录，未随公开文档提供）. The old deleted answer and the later new answer are distinct samples. These are historical observations; the latest user-confirmation guard has not been used to publish another test item.
