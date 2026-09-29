# Desktop shell

The Electrobun process is a thin shell around the same self-hosted web application. It contains no node, permission, sync, or persistence rules. By default it opens the local Docker Compose app at `http://127.0.0.1:3417`; set `ASTRYX_SERVER_URL` to the origin of another self-hosted instance.

Run `bun install` from the workspace root, then `bunx electrobun sync` in `apps/desktop` on a fresh checkout to prepare the pinned SDK. Run `bun run desktop:typecheck` and `bun run desktop:dev` on a supported desktop. Electrobun's Hutch launcher prepares the pinned runtime and build tools. `bun run desktop:build` creates a host-native canary package.

Every push to `main` builds the desktop package and installer on Linux x64, macOS arm64, and Windows x64. Download them from the commit's **Desktop packages** workflow run under **Artifacts**; the artifacts are retained for 14 days. These are unsigned canary builds for connecting to a self-hosted server. Code signing, native file and notification adapters, deep links, and updater configuration remain separate release work.
