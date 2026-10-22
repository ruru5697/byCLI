# Download Support

byCLI supports downloading images, videos, and articles from supported platforms.

For the separate upload-and-edit workflow that stops before final publication, see [视频发布准备](./video-publish-prepare.md).

## Supported Platforms

| Platform | Content Types | Notes |
|----------|---------------|-------|
| **xiaohongshu** | Images, Videos | Native MP4 download; use `--type video` to exclude covers |
| **sohu** | Article videos | Native MP4 download from Sohu account article pages |
| **bilibili** | Videos | Requires `yt-dlp` installed |
| **twitter** | Images, Videos | Downloads from user media tab or single tweet |
| **douban** | Images | Downloads poster / still image lists from movie subjects |
| **xiaoyuzhou** | Audio, Transcript | Downloads episode audio and transcript JSON/text with local credentials |
| **zhihu** | Articles (Markdown) | Exports articles with optional image download |
| **weixin** | Articles (Markdown) | Exports WeChat Official Account articles |

## Prerequisites

Xiaohongshu and Sohu account MP4 downloads use byCLI's browser extension and native HTTP downloader. They do not require `yt-dlp` or ffmpeg. Chrome and the connected byCLI extension must be available; the article/note must be accessible in that browser session.

Other streaming-platform adapters, such as Bilibili, require `yt-dlp`:

```bash
# Install yt-dlp
pip install yt-dlp
# or
brew install yt-dlp
```

## Usage Examples

```bash
# Download images/videos from Xiaohongshu note
bycli xiaohongshu download "https://www.xiaohongshu.com/search_result/<id>?xsec_token=..." --output ./xhs
bycli xiaohongshu download "https://xhslink.com/..." --output ./xhs

# Download only one preferred video stream, without the cover
bycli xiaohongshu download "<full-note-URL-with-xsec_token-or-xhslink>" --type video --output ./xhs --keep-tab false

# Download a video embedded in a Sohu account article (mobile links also work)
bycli sohu download "https://m.sohu.com/a/1028743820_121620820" --output ./sohu --keep-tab false

# Download Bilibili video (requires yt-dlp)
bycli bilibili download --bvid BV1xxx --output ./bilibili
bycli bilibili download --bvid BV1xxx --quality 1080p

# Download Twitter media from user
bycli twitter download elonmusk --limit 20 --output ./twitter

# Download single tweet media
bycli twitter download --tweet-url "https://x.com/user/status/123" --output ./twitter

# Download Douban posters / stills
bycli douban download 30382501 --output ./douban

# Download Xiaoyuzhou episode audio
bycli xiaoyuzhou download 69b3b675772ac2295bfc01d0 --output ./xiaoyuzhou

# Download Xiaoyuzhou transcript JSON + text
bycli xiaoyuzhou transcript 69dd0c98e2c8be31551f6a33 --output ./xiaoyuzhou-transcripts

# Export Zhihu article to Markdown
bycli zhihu download "https://zhuanlan.zhihu.com/p/xxx" --output ./zhihu

# Export with local images
bycli zhihu download "https://zhuanlan.zhihu.com/p/xxx" --download-images

# Export WeChat article to Markdown
bycli weixin download --url "https://mp.weixin.qq.com/s/xxx" --output ./weixin
```

`bycli xiaoyuzhou download` and `transcript` require local Xiaoyuzhou credentials in `~/.bycli/xiaoyuzhou.json`.

## Native Xiaohongshu and Sohu video downloads

Both commands accept `--timeout <seconds>` (default 120, range 1–3600). This covers each file transfer, including redirects and body streaming; browser navigation/player loading is separate. Successful results contain `path` and `bytes`. Use `-f json` for machine-readable output and `--keep-tab false` to release the command's browser tab afterward.

Xiaohongshu accepts signed full note URLs or `xhslink.com` short links, rather than bare note IDs. `--type all` is the default; `video` excludes images and `image` excludes videos. Alternative video streams are treated as one video. Browser authentication is used to read the page; site cookies are not exported to media CDNs.

Sohu accepts `sohu.com/a/<article>_<author>` URLs on the main, `www`, or `m` host. It loads the desktop article and associates the body video with its player ID. Independent `tv.sohu.com` page URLs, recommendations, and unrelated resource URLs are not accepted as article inputs. The current command downloads the first supported body video and does not expose quality selection or multi-video batch download.

The native commands require a complete MP4 container with a video track. Structural validation is not a full codec/decode check. HLS/DASH playlists, HTML/login responses, truncated transfers and malformed containers fail explicitly; a failed transfer removes its own temporary file and preserves an existing destination. HLS remuxing and HTTP Range/resume are not implemented. Site access restrictions or player changes can still prevent extraction.

Validate a downloaded file independently with ffprobe/ffmpeg when needed. These tools are only used for verification; the download command uses native HTTP and bounded MP4 structure checks.

## Pipeline Step

The `download` step can be used in pipeline adapters:

::: v-pre
```yaml
pipeline:
  - fetch: https://api.example.com/media
  - download:
      url: ${{ item.imageUrl }}
      dir: ./downloads
      filename: ${{ item.title | sanitize }}.jpg
      concurrency: 5
      skip_existing: true
```
:::
