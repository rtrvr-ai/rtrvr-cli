# Publishing to npm

Guide for publishing `@rtrvr-ai/core`, `@rtrvr-ai/sdk`, and `@rtrvr-ai/cli` to npm.

## Packages

| Package | npm | What ships |
|---------|-----|------------|
| `@rtrvr-ai/core` | [npmjs.com/package/@rtrvr-ai/core](https://www.npmjs.com/package/@rtrvr-ai/core) | API client, types, HTTP transport |
| `@rtrvr-ai/sdk` | [npmjs.com/package/@rtrvr-ai/sdk](https://www.npmjs.com/package/@rtrvr-ai/sdk) | High-level SDK wrapper |
| `@rtrvr-ai/cli` | [npmjs.com/package/@rtrvr-ai/cli](https://www.npmjs.com/package/@rtrvr-ai/cli) | CLI binary (`rtrvr` command) |

Dependency chain: `cli` -> `sdk` -> `core`. Publish in that order.

## Prerequisites

```bash
# Login to npm under the @rtrvr-ai org
npm login --scope=@rtrvr-ai

# Verify you're logged in
npm whoami
```

## Manual publish

### 1. Bump versions

All three packages must use the same version.

```bash
# Bump all packages to the same version (patch/minor/major)
pnpm -r exec -- npm version patch --no-git-tag-version

# Or set a specific version
pnpm -r exec -- npm version 0.2.1 --no-git-tag-version

# Also bump root package.json
npm version patch --no-git-tag-version
```

### 2. Build and test

```bash
pnpm build
pnpm typecheck
pnpm test
```

### 3. Dry-run to verify contents

Check what will be included in each package before publishing:

```bash
cd packages/core && npm pack --dry-run && cd ../..
cd packages/sdk && npm pack --dry-run && cd ../..
cd packages/cli && npm pack --dry-run && cd ../..
```

Each package should only contain `dist/` and `package.json`. No source files, tests, or env files.

### 4. Publish (in dependency order)

```bash
cd packages/core && pnpm publish --access public && cd ../..
cd packages/sdk && pnpm publish --access public && cd ../..
cd packages/cli && pnpm publish --access public && cd ../..
```

### 5. Commit and tag

```bash
git add -A
git commit -m "v0.1.1"
git tag v0.1.1
git push && git push --tags
```

## Automated publish (GitHub Actions)

Automated publishing is configured in `.github/workflows/publish.yml`. It runs on:

- **GitHub Release creation** — create a release in the GitHub UI or via `gh`
- **Manual dispatch** — trigger from the Actions tab

### Setup (one-time)

1. Go to [npmjs.com](https://www.npmjs.com) > Access Tokens > Generate New Token
2. Choose **Granular Access Token**
3. Scope it to the `@rtrvr-ai` org with publish permission
4. In GitHub: repo > Settings > Secrets and variables > Actions > New repository secret
5. Name: `NPM_TOKEN`, value: the token from step 3

### Triggering a release

```bash
# Option A: GitHub CLI
gh release create v0.1.1 --title "v0.1.1" --notes "Bug fixes and test improvements"

# Option B: GitHub UI
# Go to repo > Releases > Draft a new release > Tag: v0.1.1
```

The workflow will:
1. Install dependencies with `pnpm install --frozen-lockfile`
2. Build all packages
3. Publish all packages with `--provenance` (npm verified publisher badge)

## Publishing a beta/prerelease

```bash
# Set prerelease version
pnpm -r exec -- npm version 0.2.1-beta.1 --no-git-tag-version

# Publish with beta tag (users won't get it on `npm install` by default)
cd packages/core && pnpm publish --access public --tag beta && cd ../..
cd packages/sdk && pnpm publish --access public --tag beta && cd ../..
cd packages/cli && pnpm publish --access public --tag beta && cd ../..
```

Users install beta with:

```bash
npm install -g @rtrvr-ai/cli@beta
```

## Verifying a publish

After publishing, verify the packages are live:

```bash
# Check npm registry
npm view @rtrvr-ai/core version
npm view @rtrvr-ai/sdk version
npm view @rtrvr-ai/cli version

# Test global CLI install
npm install -g @rtrvr-ai/cli
rtrvr --help

# Test npx (zero-install)
npx @rtrvr-ai/cli --help

# Test SDK in a fresh project
mkdir /tmp/test-rtrvr && cd /tmp/test-rtrvr
npm init -y
npm install @rtrvr-ai/sdk
node -e "import('@rtrvr-ai/sdk').then(m => console.log(Object.keys(m)))"
```

## Troubleshooting

### "You must sign up for private packages"

Scoped packages are private by default. All three package.json files include `publishConfig.access: "public"` to handle this. If you still see this error:

```bash
pnpm publish --access public
```

### "Cannot publish over previously published version"

You need to bump the version. npm does not allow overwriting a published version.

### "workspace:* in published package"

pnpm automatically replaces `workspace:*` with the actual version when publishing. If you see literal `workspace:*` on npm, you may have used `npm publish` instead of `pnpm publish`.

### Version mismatch between packages

All three packages should always be on the same version. Use the root bump command:

```bash
pnpm -r exec -- npm version <version> --no-git-tag-version
```
