# Security policy

## Reporting a vulnerability

Please **do not open a public issue**. Report it privately through GitHub: open the repository's **Security** tab and click **Report a vulnerability**. Include the affected file or endpoint, the steps to reproduce it, and the impact.

You can expect a first answer within a week. Once the issue is fixed, the advisory will credit you, unless you prefer otherwise.

## Scope

Especially relevant:

- getting past the Cloudflare Access check in the Worker (`src/access.ts`, `src/gateway.ts`);
- making the Worker or the container fetch arbitrary or internal URLs (SSRF) through the URL parser, the Facebook share resolver or yt-dlp;
- getting R2 to serve incomplete files, or files belonging to other jobs.

Out of scope:

- problems in your own Cloudflare configuration;
- rate limits or blocks imposed by the platforms.

## Supported versions

Only the latest commit on `main` is supported.
