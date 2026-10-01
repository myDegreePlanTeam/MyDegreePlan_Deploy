# MyDegreePlan — private local install

The whole planner (app, accounts, database) running in Docker on **one computer**. It does not use Vercel or Supabase Cloud, and nobody but the person at that computer can open it. New versions arrive through a button inside the app.

## For the student

**You need:** [Docker Desktop](https://www.docker.com/products/docker-desktop) (free for personal/education use), installed and running.

1. Unzip the folder you were given anywhere (e.g. Documents).
2. **Windows:** double-click `mdp.cmd`. **Mac/Linux:** open a terminal in the folder and run `sh mdp.sh start`.
3. The first start takes a few minutes. Your browser then opens to `http://localhost:8080`. Click **Create account** (any email and an 8+ character password; nothing is emailed or verified) and start planning.

### Coming back later (one click)

- **Windows:** the first successful start adds a **MyDegreePlan** shortcut to your Desktop. Double-click it any time. If Docker Desktop is not running it is started for you (allow a minute or two), then the app opens in your browser. The console window closes itself when it is done; if something goes wrong it stays open so you can read the message. If you later move the folder or unzip a newer copy somewhere else, the next start points that shortcut at the new folder.
- **Mac:** run `sh mdp.sh start` again; it launches Docker Desktop first if needed. (No Desktop shortcut on Mac/Linux yet.)
- **Already have Docker Desktop running?** The app restarts along with it, so `http://localhost:8080` works without running anything. Bookmark it. In Docker Desktop's settings you can turn on **Start Docker Desktop when you sign in** and the app is then simply there whenever the computer is on.
- `mdp stop` when you're done if you'd like it off (your plan is kept).
- **Keep the `.env` file** in the MyDegreePlan folder. It belongs to your data; if you move to a new folder without it, the launcher refuses to start rather than lock you out. Copy the whole folder, `.env` included.

Set `MDP_NO_SHORTCUT=1` (environment variable) before the first start if you do not want the Desktop shortcut.

### Updates

You never need to type anything to update. When a new version is out, a card appears in the corner of the app: **"MyDegreePlan 1.3.0 is available"**, with what changed. Press **Update now** and wait about a minute; the page reloads on the new version by itself. Your plan is backed up first, and if anything goes wrong the previous version is put back automatically and the app tells you.

- **Later** hides the card for this session.
- **Install updates automatically** (in the card) applies new versions as soon as they are found. It is off by default, because the app briefly restarts while it updates.
- Rarely, a version is marked **required** (a serious fix). You will see a screen that only offers **Update now**.

| Command (`mdp.cmd <cmd>` on Windows, `sh mdp.sh <cmd>` on Mac/Linux) | What it does |
|---|---|
| `start` | Start (also the default) and open the browser |
| `stop` | Stop the app; data stays |
| `backup` | Snapshot everything into `backups\` (briefly restarts the app) |
| `restore <file>` | Replace all data with a backup |
| `reset-password <email>` | Set a new password. There is no "forgot password" email — this is the recovery path |
| `wipe` | **Permanently** delete all plans and accounts |

Keep the `.env` file (created on first start) with your data. It holds this install's passwords/keys; if it is lost, existing data can't be opened.

## What "private" means here

**Guaranteed by the design**
- Your plan lives in a Docker volume on your own disk. There is no server elsewhere.
- Only the web container is reachable, and only at `127.0.0.1` — not from other devices on your Wi-Fi. The database and APIs have no ports open at all.
- The page is served with a Content-Security-Policy that only allows connections to itself, and the Google Fonts request the hosted version makes is removed at build time, so opening the planner contacts no third party. (Text uses your system fonts instead of DM Serif/DM Mono.)
- Passwords are hashed by the auth service. Secrets are randomly generated per computer, never shared between installs, and not baked into the images.
- Row-level security still separates accounts if you create more than one.

**The update check — the one thing that does go out**
A small background service (`updater`) asks GitHub for a version file (about 1 KB) when the app starts and every ~6 hours, and downloads new versions from GitHub's container registry when you press Update. That is an ordinary web request: GitHub can see your computer's IP address and that it asked for the file, like any download. **Nothing about you or your plan is sent** — no account, email, plan data, install ID, or even which version you run. To turn the check off completely, add the line `MDP_UPDATES=off` to your `.env` file and run `mdp start`; then updates only arrive if someone gives you a new bundle.

**Not covered — your responsibility**
- Anyone who can log into your computer, or read your disk, can read the data (and can run `reset-password`). Use a Windows/macOS login password and turn on **BitLocker / FileVault** if the laptop could be lost.
- `backups\` files and `.env` are unencrypted. Don't put them in a shared or synced folder you don't trust.
- Docker itself must be from Docker Inc./your OS package manager.

## For the maintainer

Layout (this folder sits next to `MyDegreePlan_Frontend/` and `MyDegreePlan_Prototype/` and builds from both; in CI it is checked out beside them the same way):

```
docker-compose.yml   the dev/source compose file: db · auth · migrate · rest · web · updater · seed
db/                  supabase/postgres + roles.sql baked in (one-time role passwords)
setup/               one-shot image: sql/000_baseline.sql + the Prototype's seed.js, catalog JSON, SQL
web/                 builds the React app, nginx config (proxies /rest/v1, /auth/v1, /_mdp/update; CSP)
updater/             the in-stack updater (zero npm dependencies, holds the Docker socket) + tests
release-tools/       builds and signs a release: keygen, image pinning, compose generation, verification
.github/workflows/   release.yml (publish a release) · ci.yml (tests on every push)
mdp.ps1 / mdp.cmd / mdp.sh   launcher: secret generation, start/stop/backup/restore/…
```

How the app itself works: supabase-js is pointed at the page's own origin; nginx forwards `/rest/v1` to PostgREST and `/auth/v1` to GoTrue, exactly the paths hosted Supabase exposes, so the app needed one 3-line change (`src/lib/supabaseClient.js` reads `window.__MDP_CONFIG__` first, falling back to the `VITE_` variables, so Vercel is unaffected). The web container writes `/config.js` with the anon key at start-up. Startup order: db → auth → migrate (SQL) → rest → web → seed (`seed.js`, re-runnable by design).

### How updates work

Updates are the primary way to change what students run. GitHub and Vercel are no longer in that path for Docker installs.

```
you: Actions → Release → Run workflow (version, notes, required?)
  CI: tests → build 4 multi-arch images → push to GHCR → pin every image by digest
      → generate docker-compose.yml (pinned) + release.json → sign it → verify it with the
        updater's own code → publish as a GitHub Release (+ fresh-install zip)

student's app:  updater checks .../releases/latest/download/release.json  (start, then ~6h)
   → verifies the signature and that the sequence number is newer
   → the in-app card offers it; on "Update now":
        pull the new images (app keeps running) → stop → snapshot the database volume
        → start the new version → wait for healthy + catalog loaded → reload page
        on ANY failure: stop new, restore the snapshot, start the old version, tell the student
```

Each release is three small files (`release.json`, `release.json.sig`, `docker-compose.yml`) plus the images. `release.json` carries the version, notes, a monotonically increasing `sequence`, `min_sequence` (installs below it are blocked until they update — what "required" means, carried forward so a later optional release can't lift it), the SHA-256 of the compose file, and the exact source commits used.

### Security model

The updater can restart the stack, which requires the Docker socket. **That is root-equivalent on the student's computer**, so what it will accept is deliberately narrow:

- **Only signed releases.** `release.json` is ECDSA P-256 signed. The public key is baked into the updater image. The private key exists only as the `MDP_SIGNING_KEY` secret. A tampered file, a hijacked download, or a stolen registry push can't make an install run anything, because nothing without a valid signature is used.
- **Everything pinned.** The signed manifest holds the compose file's hash; that file names every image by `@sha256:` digest (third-party ones too), and the updater refuses a compose file with a floating tag, a `build:`, `privileged`, host networking, or any host bind-mount other than the socket.
- **No downgrades.** A release only applies if its `sequence` is higher than the running one, so replaying an old signed release does nothing.
- **Locked-down endpoint.** No host ports; reachable only through nginx at `/_mdp/update/*` on `127.0.0.1`. Every call needs an access token minted by that install's own auth service (not the public anon key), and the `Host`/`Origin` must be that install's own local address, which stops other websites and DNS-rebinding. It takes **no parameters** that choose what runs: "apply" means "apply the latest verified release". No request data ever reaches a shell.
- **Secrets stay off command lines.** They reach the apply helper by variable name, not value.
- **Privacy:** see above — the only outbound traffic is the file check and the image pull.

What this does **not** protect against: whoever holds the signing key (or can change the workflow and read the secret) can ship code to every student. Treat that key like a production root credential — see the setup steps.

### One-time setup

1. **Create the repo** `myDegreePlanTeam/MyDegreePlan_Deploy` from this folder (`git init`, add the remote, push). **It must be public**: students' installs fetch `releases/latest/download/…` anonymously, and a private repo would answer 404. It contains no secrets and no app source (the Frontend/Prototype are only checked out inside CI).
2. **Generate the signing key** on your machine: `node release-tools/keygen.mjs`. Commit the new `updater/release-signing.pub.pem`. Put the printed private key into a GitHub **Environment** named `release` as the secret `MDP_SIGNING_KEY`, keep an offline copy in a password manager, delete the file. In the environment settings add yourself (or a second person) as a **required reviewer**, so each release needs an explicit approval.
3. **If the Frontend/Prototype repos are private**, add a read-only fine-grained token for both as the secret `SOURCES_TOKEN`.
4. **Run the first release** (see below). It builds the images and pushes them to `ghcr.io/mydegreeplanteam/`. GHCR creates packages **private** by default: for each of `mdp-web`, `mdp-setup`, `mdp-db`, `mdp-updater` open *Package settings → Change visibility → Public*. The workflow checks this and stops with instructions if a package is still private (the images hold no secrets: keys are injected at runtime and `.env` is excluded from the build).
5. Re-run the workflow. It publishes the release and a fresh-install zip.

### Shipping a release

Actions → **Release** → Run workflow:

| Input | |
|---|---|
| `version` | `1.3.0`. Releases are immutable; a version can't be reused |
| `notes` | What students read in the update card. Plain sentences, one per line |
| `required` | Tick only for urgent fixes: older installs are blocked until they update |
| `frontend_ref` / `prototype_ref` | Branch, tag or SHA to build (default `main`); the exact commits are recorded in `release.json` |

The `release` environment asks for approval, then CI runs the tests, builds, signs, checks the result, and publishes. Students' apps pick it up on their next start or within about 6 hours. A catalog change (JSON/SQL in `MyDegreePlan_Prototype`) is shipped the same way: the seed runs on every update and existing data is kept. Schema changes: edit `setup/sql/000_baseline.sql` (or add an idempotent `setup/sql/NNN_*.sql`) and, for a student table, the `STUDENT_TABLES` defaults in the Frontend's `src/lib/data/localClient.js`. There are no Supabase `migration_tierN.sql` files any more. If the change adds a table, `GRANT` it explicitly. Code that reads a new column should tolerate an install whose setup step has not re-run (retry the read without it).

### Students already on the old (pre-updater) bundle

They have no updater, so they need **one last manual step**: give them the fresh-install zip from the latest Release, and have them copy its files over their existing folder (replace `docker-compose.yml`, `mdp.*`, `README.md`; **keep `.env` and `backups\`**), then run `mdp start`. Their data and accounts carry over. From then on updates are the button.

### Diagnostics and recovery

- `mdp update` (checks) / `mdp update apply` (installs) talk to the updater from a terminal — for you, not students. The output includes the technical reason for a failed update, which the app deliberately hides from students.
- `mdp logs` shows the updater's own log (`[mdp-updater] …`).
- Before each update the updater snapshots the database volume into the `mdp_update_state` volume (`/state/snapshots/pre-<from>-to-<to>.tar.gz`, the newest two are kept). It is the same format `mdp backup` writes, so a snapshot can be copied out with `docker run --rm -v mdp_update_state:/s -v "%cd%\backups:/b" alpine cp /s/snapshots/<file> /b/` and given to `mdp restore` (along with the install's `.env`).
- A failed update leaves the student on the previous version; they can press **Try again** or you can ship a fixed release. If both the new version and the automatic rollback fail, the app says so and tells the student to run `mdp start`.

### Developing

`mdp start --build` (`-Build` in PowerShell) builds from the repo's own `docker-compose.yml` and always uses it; the updater in a developer build has no signing key and no address, so it stays disabled and can't replace your containers. Tests: `cd updater && npm test`, `cd release-tools && npm ci && npm test` (`ci.yml` runs both on every push). `mdp package` still builds an offline image tar for hand-off without internet, but a Release bundle is the normal route.

Data: Docker volumes `mdp_db_data` / `mdp_db_config` (database) and `mdp_update_state` (update files and snapshots). Change the port by editing `MDP_PORT` in `.env`.

## Known gaps — please read before shipping

- **Verified end to end on Windows 11 + Docker Desktop (2026-09-29), with a local registry standing in for GHCR and a local web server standing in for GitHub Releases, on isolated test volumes:** first start from a digest-pinned release compose; the update card in the real app; **Update now** through the UI, including the progress screen and automatic reload; the signed-release check; a required update (blocking screen); automatic mode; a new version that fails to start (rolled back, data intact, plain-language message); a download that fails (app untouched); `mdp start` after an update keeps the newer version and recreates nothing; the `Host`/`Origin`/token guards over HTTP; a data marker surviving every update. Earlier (same day): clean first start, sign-up, onboarding with an AP credit, plan build, PDF preview under the CSP, RLS isolation, `reset-password`, `backup` and a scratch restore.
- **Not run for real:** the GitHub Actions workflows (they were checked only for valid YAML, and every script they call was exercised locally — the first real run will probably need a small fix), pulls from actual GHCR, the multi-arch/arm64 builds, macOS/Linux (`mdp.sh` is syntax-checked only), and `mdp restore` over a live volume.
- **Key rotation isn't automated.** Rotating means shipping a release signed with the old key that contains the new public key, and the workflow's final check assumes one key. If the key is ever exposed, treat it as an incident: publish a required release from a clean key path and have students take a fresh-install zip.
- **Freeze attack:** someone able to answer a student's network requests could replay an old (validly signed) release to keep them from seeing a new one. They cannot make them run anything.
- **The updater's Docker access cannot be removed** for a one-click button; the safeguards above are what keep it narrow. Someone who already controls the student's Docker or the GitHub repo/signing key is outside what this protects.
- Compose prints "pull access denied" for `mydegreeplan/*` images on the first `--build` run. That's harmless: they are local-only images and it goes on to build them.
- The image's default grants gave `anon`/`authenticated` every privilege (including TRUNCATE) on new tables; `000_baseline.sql` now revokes them and grants only what the app needs. A schema change that adds a table must GRANT it explicitly.
- **The base schema is reconstructed.** `courses`, `concentrations`, `requirement_slots`, `student_profiles`, `student_plan_slots`, `student_semester_notes` and the catalog tables were created by hand in the Supabase dashboard and were never in the repo. `000_baseline.sql` rebuilds them from `seed.js`, the frontend's queries, and migration tiers 6–20. Diff it against `pg_dump --schema-only` of the hosted project before trusting edge cases (extra constraints, defaults, indexes).
- A `student_profiles` auth trigger is mentioned in a comment in `Signup.jsx`; it is not recreated. `Dashboard.jsx` already inserts the profile if it's missing, so sign-up works without it.
- No email: accounts auto-confirm and there is no self-service password reset (`reset-password` covers it).
- Backups and update snapshots are whole-volume copies tied to the same Postgres major version (17).
