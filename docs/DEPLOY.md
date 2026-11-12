# Deploying your own instance

Everything below runs in your own Cloudflare account. Expect about 20 minutes.

## 1. Clone and install

```sh
git clone https://github.com/guifav/video-downloader.git
cd video-downloader
npm ci
npx wrangler login
```

## 2. Create the R2 bucket with a 1-day lifecycle

```sh
npx wrangler r2 bucket create video-downloader-files
npx wrangler r2 bucket lifecycle add video-downloader-files expire-1d --expire-days 1 --force
```

If you pick another bucket name, change `r2_buckets[0].bucket_name` in `wrangler.jsonc`.

## 3. Set up Cloudflare Access

This step is required: the Worker refuses any request without a valid Access JWT.

1. In Zero Trust, note your team domain (`<team>.cloudflareaccess.com`).
2. Create a **self-hosted application** for your hostname, for example `video.example.com`. Give it a policy that allows only your email (add more emails later to share it; each user sees only their own downloads); the one-time PIN login method is enough.
3. Copy the application's **AUD tag**.

## 4. Configure `wrangler.jsonc`

1. Set `routes[0].pattern` to your hostname. It must be on a zone in this account; `wrangler deploy` creates the custom domain.
2. Fill in the Access values from step 3:
   - `vars.ACCESS_TEAM_DOMAIN`;
   - `vars.ACCESS_AUD`;
   - `vars.ACCESS_ALLOWED_EMAILS`, comma separated.
3. Optionally, set up the smoke-test email:
   - `vars.ALERT_EMAIL_FROM`: an address on a zone with Email Routing enabled;
   - `vars.ALERT_EMAIL_TO`: a verified destination.

   Leave both empty to only log the report. To turn the smoke test off completely, remove `triggers.crons`.
4. Regenerate the types: `npm run cf-typegen`.

If you deploy from your own fork or clone and want to keep your values out of git, copy the file to `wrangler.local.jsonc` (already in `.gitignore`), edit that copy instead, and pass it to every wrangler command with `-c wrangler.local.jsonc`, for example `npx wrangler deploy -c wrangler.local.jsonc`.

## 5. Add cookies (optional)

At the time of writing, public videos from YouTube, X, Instagram, Facebook and TikTok downloaded fine from Cloudflare's network without cookies. If a platform starts blocking, add cookies as a base64-encoded Netscape cookies file. Always take them from a **throwaway account, never your personal one**.

```sh
base64 -w0 cookies.txt | npx wrangler secret put YT_COOKIES_B64   # also IG_COOKIES_B64, FB_COOKIES_B64, TT_COOKIES_B64
```

## 6. Deploy

Docker must be running: the container image is built locally and pushed to Cloudflare's registry.

```sh
npm run check     # typecheck, tests and a dry-run deploy
npm run deploy
```

Open your hostname, log in through Access and paste a link.

## Costs and limits

- Each download runs one `standard-4` container for the length of the job. That is usually well under a minute; long Facebook videos that need conversion take a few minutes.
- Each job gets up to 3 attempts of at most 14 minutes each. Files and state are deleted after 24 hours.
- The weekly smoke test runs 6 jobs per week.
- Every image build installs the latest yt-dlp. When a platform breaks and yt-dlp ships a fix, redeploy.
