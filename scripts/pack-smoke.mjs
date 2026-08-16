/**
 * pack smoke test — 「npm publish される tarball が消費者の手元で動くか」の gate
 *
 * 検証内容 (docs/TASK-260720-release-gate.md):
 * 1. npm pack の同梱物に LICENSE / README / dist が含まれる
 * 2. tarball を展開し、main / react / testing / firebase の 4 entry を
 *    消費者と同じ経路で runtime import できる (主要 export の存在まで確認)
 * 3. dist に焼き込まれた SYNQUX_VERSION が package.json と一致する
 *    (stale dist 検出の本丸: build 忘れの古い dist を pack した場合にここで落ちる)
 * 4. SYNQUX_SCHEMA_VERSION が src/core/types.ts の宣言と一致する (同上)
 * 5. 展開した d.ts を paths 解決する consumer.ts が tsc --noEmit を通る (型配布の smoke)
 *
 * 前提: 事前に `npm run build` 済みであること (prepublishOnly = test → build → smoke)。
 * 展開先は bare specifier (react 等の peer deps) が repo の node_modules へ
 * 解決される必要があるため、repo 内の node_modules/.synqux-smoke/ を使う。
 */
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workDir = join(repoRoot, 'node_modules', '.synqux-smoke')
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8'))

const fail = (message) => {
  console.error(`[pack-smoke] NG: ${message}`)
  process.exit(1)
}
const assert = (condition, message) => {
  if (!condition) {
    fail(message)
  }
}

if (!existsSync(join(repoRoot, 'dist'))) {
  fail('dist がありません。先に `npm run build` を実行してください')
}

rmSync(workDir, { recursive: true, force: true })
mkdirSync(workDir, { recursive: true })

// ---- 1. pack と同梱物の確認 --------------------------------------------
const packJson = JSON.parse(
  execFileSync(
    'npm',
    ['pack', '--json', '--pack-destination', workDir],
    { cwd: repoRoot, encoding: 'utf-8' },
  ),
)
const [packed] = packJson
const packedFiles = packed.files.map((file) => file.path)

for (const required of ['LICENSE', 'README.md', 'package.json', 'dist/index.js']) {
  assert(packedFiles.includes(required), `tarball に ${required} が含まれていません`)
}

// ---- 2. 展開して 4 entry を runtime import ------------------------------
execFileSync('tar', ['-xzf', join(workDir, packed.filename)], { cwd: workDir })
const distDir = join(workDir, 'package', 'dist')

const entryUrl = (relative) => pathToFileURL(join(distDir, relative)).href

const main = await import(entryUrl('index.js'))
for (const name of [
  'createSynqux',
  'createSynquxRootReducer',
  'generateResult',
  'selectIsHost',
]) {
  assert(typeof main[name] === 'function', `main entry の export ${name} が欠落`)
}

const react = await import(entryUrl('react/index.js'))
// react entry は useSynquxSubscription のみ (ADR-0022 / ADR-0023)。完全一致で
// 検証し、廃止 API (Provider / 読み取り hooks) の残存 = stale dist を検出する
assert(
  typeof react.useSynquxSubscription === 'function',
  'react entry の export useSynquxSubscription が欠落',
)
assert(
  JSON.stringify(Object.keys(react).sort()) ===
    JSON.stringify(['useSynquxSubscription']),
  `react entry の export が想定外です (ADR-0022 / ADR-0023 で useSynquxSubscription のみ): ${Object.keys(react).join(', ')}`,
)

const testing = await import(entryUrl('testing/index.js'))
assert(
  typeof testing.createMemoryHub === 'function',
  'testing entry の export createMemoryHub が欠落',
)

const firebase = await import(entryUrl('firebase/index.js'))
assert(
  typeof firebase.firebaseTransport === 'function',
  'firebase entry の export firebaseTransport が欠落',
)

// ---- 3, 4. version / schema version の突合 (stale dist 検出) -------------
assert(
  main.SYNQUX_VERSION === pkg.version,
  `dist の SYNQUX_VERSION (${main.SYNQUX_VERSION}) が package.json (${pkg.version}) と不一致。` +
    'dist が stale です。`npm run build` からやり直してください',
)

const typesSource = readFileSync(
  join(repoRoot, 'src', 'core', 'types.ts'),
  'utf-8',
)
const schemaInSource = Number(
  typesSource.match(/SYNQUX_SCHEMA_VERSION = (\d+)/)?.[1],
)
assert(
  Number.isFinite(schemaInSource),
  'src/core/types.ts から SYNQUX_SCHEMA_VERSION を読み取れません',
)
assert(
  main.SYNQUX_SCHEMA_VERSION === schemaInSource,
  `dist の SYNQUX_SCHEMA_VERSION (${main.SYNQUX_SCHEMA_VERSION}) が ` +
    `src (${schemaInSource}) と不一致。dist が stale です`,
)

// ---- 5. 型配布の smoke (展開済み d.ts を消費者視点で tsc) -----------------
writeFileSync(
  join(workDir, 'consumer.ts'),
  [
    "import { createSynqux, createSynquxRootReducer, generateResult, type SynquxTransport, type Result } from 'synqux'",
    "import { useSynquxSubscription } from 'synqux/react'",
    "import { createMemoryHub, type MemoryHub } from 'synqux/testing'",
    "import { firebaseTransport } from 'synqux/firebase'",
    '',
    'export const smoke = {',
    '  createSynqux,',
    '  createSynquxRootReducer,',
    '  generateResult,',
    '  useSynquxSubscription,',
    '  createMemoryHub,',
    '  firebaseTransport,',
    '}',
    'export type SmokeTypes = { transport: SynquxTransport; result: Result; hub: MemoryHub }',
    '',
  ].join('\n'),
)
writeFileSync(
  join(workDir, 'tsconfig.smoke.json'),
  JSON.stringify(
    {
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: 'es2022',
        module: 'esnext',
        moduleResolution: 'bundler',
        jsx: 'react-jsx',
        // 消費者が package.json exports 経由で解決する d.ts を直接指す
        // (paths は tsconfig の位置基準で解決される。baseUrl は TS7 で廃止)
        paths: {
          synqux: ['./package/dist/index.d.ts'],
          'synqux/react': ['./package/dist/react/index.d.ts'],
          'synqux/testing': ['./package/dist/testing/index.d.ts'],
          'synqux/firebase': ['./package/dist/firebase/index.d.ts'],
        },
      },
      files: ['./consumer.ts'],
    },
    null,
    2,
  ),
)
execFileSync('npx', ['tsc', '-p', join(workDir, 'tsconfig.smoke.json')], {
  cwd: repoRoot,
  stdio: 'inherit',
})

console.log(
  `[pack-smoke] OK: ${packed.filename} (v${pkg.version} / schema v${schemaInSource})`,
)
