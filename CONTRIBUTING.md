# Contributing

Thanks for your interest! This is a small project, and the goal is to keep it small, simple and reliable.

## Before you start

- **Bugs:** open an issue with the kind of link (the exact link is not required), what you expected, and the error shown in the UI.
- **Features:** open an issue first, so we agree on the scope before you write code. The project downloads **single videos** only; playlists, channels, profiles and stories are out of scope on purpose.
- **New platforms:** welcome, as long as yt-dlp supports them and they work from Cloudflare's network without personal accounts.
- **Security issues:** do not open a public issue. See [SECURITY.md](SECURITY.md).

## Setup

You need:

- Node.js 24 and npm;
- Docker, to run the container tests inside the production image.

```sh
npm ci
npm run typecheck && npm test
docker build -t video-downloader-ci .
docker run --rm -e PYTHONDONTWRITEBYTECODE=1 -v "$PWD/container:/t:ro" -w /t video-downloader-ci python -m unittest test_app -v
```

Without Docker, you can run the Python tests with a local `ffmpeg` and `pip install "yt-dlp[default]"`:

```sh
cd container && python3 -m unittest test_app
```

## Pull requests

- Keep each PR to one topic, small enough to review in one sitting.
- Every behavior change comes with a test that fails without the change.
- CI must be green. It runs the typecheck, vitest, and the container tests inside the production image.
- Write commit messages as [Conventional Commits](https://www.conventionalcommits.org/) (`fix:`, `feat:`, `docs:`, `test:`, `chore:`).
- Write new code, comments and docs in English.
  - Existing comments are in Portuguese, because the project started as a personal tool. Translating them as you touch a file is welcome.
  - References like "PR #8" or "issue #6" in old comments point to the original private history, not to this repository.
- If you change bindings or vars in `wrangler.jsonc`, run `npm run cf-typegen` and commit `worker-configuration.d.ts`.

## Design invariants

These rules keep the app safe and cheap to run. A change that breaks one of them needs a very good reason, discussed in an issue first. The detailed version, in Portuguese, is in [docs/contrato-de-falhas.md](docs/contrato-de-falhas.md).

1. **Input and network:** only canonical single-video URLs of the supported platforms reach the container, and only that platform's yt-dlp extractor runs. The container blocks connections to non-public addresses. The Worker makes only one kind of request from user input: resolving Facebook share links. Each hop is rebuilt from the share token; a raw `Location` header is never followed.
2. **Access:** the Worker never answers outside Cloudflare Access. `workers_dev` and preview URLs are off, and JWT validation fails closed.
3. **Integrity:** a file in R2 is always complete (fixed length, atomic put). Partial files are never served.
4. **Bounded cost:** each job runs the container at most 3 times, for up to 14 minutes each. Jobs that cannot finish, like live streams or very long videos, fail with a clear message instead of retrying.
5. **No hot loops:** every retry is scheduled by an alarm with a minimum delay.
6. **Normal path:** when no infrastructure fails, a job ends either `done` or `failed`:
   - `done`: the file is H.264, or the original with a visible warning;
   - `failed`: the error shown is yt-dlp's real message.

   Everything is deleted after 24 hours.
7. **No personal accounts:** cookies, if used at all, come from throwaway accounts and live in Worker secrets, never in the repository.

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By participating, you agree to uphold it.
