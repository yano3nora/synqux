/**
 * Release flow の薄い wrapper (kawsay scripts/release.ts の npm 版)。
 *
 * synqux は npm ライブラリのため、配布の本体は `npm publish`。GitHub Release は
 * `gh release create --generate-notes` で作る (何もコンパイルしないので goreleaser は
 * 使わない)。この script が集約するのは goreleaser/gh に寄せられないもの:
 *   version の単一ソース化 (package.json / package-lock / src/index.ts の 3 点同期)、
 *   check/test/build/smoke、tag と VERSION の整合チェック、人間による publish ゲート。
 *   変更履歴は GitHub Release (gh --generate-notes) に残す (CHANGELOG.md は持たない)。
 *
 * Flow:
 *   1. prepare : bump + test/build/smoke (publish なしの検証)
 *   2. 人間    : version bump を commit し、`git tag v<version>` を打つ
 *   3. publish : 整合チェック → push → `npm publish` → `gh release create`
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const PROJECT_NAME = 'synqux'
// SYNQUX_VERSION は entry point に焼き込まれ、dist にも入る。package.json (semver の正)
// から派生させ、両者の食い違いを src/index.test.ts と pack-smoke が検出する
const VERSION_FILE = 'src/index.ts'
const PUBLISH_FLAG = '--i-understand-this-pushes-and-publishes'

const usage = () =>
  `Usage:
  node scripts/release.mjs prepare <version>
  node scripts/release.mjs publish <version> ${PUBLISH_FLAG}

Examples:
  mise run release:prepare -- 0.3.0
  mise run release:publish -- 0.3.0 ${PUBLISH_FLAG}`

function parseArgs() {
  const [command, version, ...rest] = process.argv.slice(2)

  if (command !== 'prepare' && command !== 'publish') {
    throw new Error(`Unknown command.\n\n${usage()}`)
  }
  if (version === undefined || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(
      `Release version must be semver-like, for example 0.3.0.\n\n${usage()}`,
    )
  }

  return { command, version, publishAllowed: rest.includes(PUBLISH_FLAG) }
}

/**
 * @param {object} [options]
 * @param {boolean} [options.stream] 出力を端末へ直接流す (戻り値は空文字)。長時間コマンド用
 * @param {boolean} [options.quiet]  コマンドと stdout を表示しない。秘匿値を扱うコマンド用
 * @param {Record<string,string>} [options.env] 追加環境変数
 */
function run(command, args, options = {}) {
  if (!options.quiet) {
    console.log(`$ ${[command, ...args].join(' ')}`)
  }

  try {
    const stdout = execFileSync(command, args, {
      encoding: 'utf-8',
      // stream 時は端末へ inherit。それ以外は捕捉して戻り値にする
      stdio: options.stream ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      env: options.env ? { ...process.env, ...options.env } : process.env,
    })

    if (!options.stream && !options.quiet && stdout?.trim()) {
      console.log(stdout.trimEnd())
    }
    return options.stream ? '' : (stdout ?? '')
  } catch (error) {
    // 失敗時の stderr は quiet でも出す。stdout は秘匿値の可能性があるため出さない
    if (!options.stream && error.stderr?.trim()) {
      console.error(error.stderr.trimEnd())
    }
    throw new Error(`Command failed: ${command} ${args.join(' ')}`)
  }
}

const readPkgVersion = () =>
  JSON.parse(readFileSync('package.json', 'utf-8')).version

const versionPattern = /export const SYNQUX_VERSION = '(\d+\.\d+\.\d+)'/

/**
 * package.json / package-lock.json / src/index.ts を目標 version へ揃える。
 * package.json + lock は npm に任せ (lock の整合を人手で崩さない)、src だけ書き換える。
 */
function bump(version) {
  // --no-git-tag-version: commit/tag と clean-tree チェックを行わずファイルだけ更新する
  run('npm', [
    'version',
    version,
    '--no-git-tag-version',
    '--allow-same-version',
  ])

  const source = readFileSync(VERSION_FILE, 'utf-8')
  if (!versionPattern.test(source)) {
    throw new Error(`SYNQUX_VERSION の宣言が ${VERSION_FILE} に見つかりません。`)
  }
  writeFileSync(
    VERSION_FILE,
    source.replace(
      versionPattern,
      `export const SYNQUX_VERSION = '${version}'`,
    ),
  )
}

// tag と焼き込み version の食い違いを publish 前に止める最後の網
function assertVersionMatch(version) {
  const inSource = readFileSync(VERSION_FILE, 'utf-8').match(versionPattern)?.[1]
  const inPkg = readPkgVersion()

  if (inSource !== version || inPkg !== version) {
    throw new Error(
      `Version mismatch: expected ${version}, but package.json=${inPkg}, ` +
        `${VERSION_FILE}=${inSource}. Run release:prepare first.`,
    )
  }
}

function assertCleanTree() {
  if (run('git', ['status', '--porcelain'], { quiet: true }).trim() !== '') {
    throw new Error(
      'Working tree must be clean before publishing. Commit the version bump first.',
    )
  }
}

// goreleaser は tag 済みコミットから GitHub Release を作る前提。tag が HEAD を指すことを保証する
function assertTagAtHead(tag) {
  let tagCommit
  try {
    tagCommit = run('git', ['rev-parse', '--verify', `${tag}^{commit}`], {
      quiet: true,
    }).trim()
  } catch {
    throw new Error(`Tag ${tag} does not exist. Create it yourself: git tag ${tag}`)
  }

  const head = run('git', ['rev-parse', 'HEAD'], { quiet: true }).trim()
  if (tagCommit !== head) {
    throw new Error(
      `Tag ${tag} does not point at HEAD. Move the tag to the release commit.`,
    )
  }
}

function prepare(version) {
  bump(version)
  assertVersionMatch(version)

  // publish の prepublishOnly (test → build → smoke) をここで先取りして全部失敗させておく
  run('npm', ['test'], { stream: true })
  run('npm', ['run', 'build'], { stream: true })
  run('node', ['scripts/pack-smoke.mjs'], { stream: true })

  console.log(
    `\nPrepared v${version}. Review the diff, commit the bump, ` +
      `tag it (git tag v${version}), then run release:publish.`,
  )
}

function publish(version, publishAllowed) {
  if (!publishAllowed) {
    throw new Error(
      `Refusing to push and publish without ${PUBLISH_FLAG}.`,
    )
  }

  const tag = `v${version}`

  assertVersionMatch(version)
  assertCleanTree()
  assertTagAtHead(tag)

  // gh は自身の認証を使うため token の受け渡しは不要。push 前に認証だけ確かめて
  // 「npm publish 済みなのに Release だけ作れない」中途半端を避ける
  run('gh', ['auth', 'status'], { quiet: true })

  // 先に remote を tag まで揃える (push は失敗しても tag を消して再実行できる)。
  // その後 npm publish で prepublishOnly (test/build/smoke) が最終ゲートとして走る
  run('git', ['push', 'origin', 'HEAD'])
  run('git', ['push', 'origin', tag])
  run('npm', ['publish', '--access', 'public'], { stream: true })

  // GitHub Release へ添付する tarball を作る (古いものが混ざらないよう掃除してから pack)。
  // --generate-notes は前 tag からの commit/PR で release notes を自動生成する
  const tarball = `${PROJECT_NAME}-${version}.tgz`
  run('rm', ['-f', tarball])
  run('npm', ['pack'], { stream: true })
  run('gh', ['release', 'create', tag, tarball, '--generate-notes'], {
    stream: true,
  })

  console.log(`\nPublished ${tag} to npm and created the GitHub Release.`)
}

try {
  const { command, version, publishAllowed } = parseArgs()
  if (command === 'prepare') {
    prepare(version)
  } else {
    publish(version, publishAllowed)
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
