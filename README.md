# video-downloader

A small, self-hosted web app that downloads **single videos** from YouTube, X (Twitter), Instagram and Facebook. It runs entirely on Cloudflare:

- a Worker serves the API and the UI;
- one Cloudflare Container per job runs yt-dlp and ffmpeg;
- R2 holds the files temporarily;
- Cloudflare Access makes sure only you can use it.

[![ci](https://github.com/guifav/video-downloader/actions/workflows/ci.yml/badge.svg)](https://github.com/guifav/video-downloader/actions/workflows/ci.yml)

## Features

- **Paste a link, get an MP4.** Quality goes up to 1080p, counted on the shorter side, so a vertical video keeps 1080 px of width.
- **Plays everywhere.** The output is H.264 + AAC, which opens in QuickTime, Photos and Safari.
  - Videos that only exist in VP9 or AV1 (common on Facebook) are converted.
  - If the conversion does not fit the time budget, you get the original file with a visible warning.
  - The UI shows the resolution you actually got.
- **Supported links:**
  - YouTube videos and Shorts;
  - X posts with video;
  - Instagram posts and reels (the first video of a carousel);
  - Facebook videos, reels and `facebook.com/share/v|r/` links.
- **Out of scope:** live streams in progress are refused with a clear message. Playlists, channels, stories and profiles are not supported.
- **Cleanup:** files and job state are deleted after 24 hours. An R2 lifecycle rule is the safety net.
- **Server-side job list:** it survives page reloads and works across devices.
- **Optional weekly smoke test:** a cron inside the Worker downloads one known video per platform and can email you the result.

## How it works

1. The UI (`public/index.html`) posts the URL to `POST /api/jobs`.
2. The Worker (`src/index.ts`):
   - checks the Cloudflare Access JWT (`src/access.ts`);
   - validates the URL (`src/urls.ts`), resolving Facebook share links first (`src/share.ts`);
   - creates the job in its own Durable Object (`src/container.ts`, with the logic in `src/engine.ts`).
3. The Durable Object alarm starts a dedicated container (`container/app.py`, with yt-dlp, ffmpeg and Deno). The container downloads the video, converts it to H.264 when needed and streams the file back.
4. The file goes to R2. The UI polls `GET /api/jobs/:id` and downloads from `GET /api/files/:id`.

## Requirements

- A Cloudflare account on the **Workers Paid** plan (needed for Containers and Durable Objects).
- A domain (zone) in that account for the app's hostname.
- Cloudflare Access to protect the hostname. The free Zero Trust plan is enough.
- Node.js 24 and Docker. Wrangler builds the container image locally on deploy.

Step-by-step setup: [docs/DEPLOY.md](docs/DEPLOY.md).

## Development

```sh
npm ci
npm run typecheck && npm test          # Worker: TypeScript + vitest

# Container tests, inside the same image used in production (what CI runs):
docker build -t video-downloader-ci .
docker run --rm -e PYTHONDONTWRITEBYTECODE=1 -v "$PWD/container:/t:ro" -w /t video-downloader-ci python -m unittest test_app -v
```

`npx wrangler dev` runs locally, but the Worker answers 403 to any request without a Cloudflare Access JWT.

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md). To report a security issue, see [SECURITY.md](SECURITY.md).

## Legal

This is a self-hosted tool for personal use, and you are responsible for how you use it:

- download only content you have the right to download;
- respect each platform's terms of service and the authors' copyright.

The maintainers do not host, store or distribute any content.

## License

[MIT](LICENSE)
