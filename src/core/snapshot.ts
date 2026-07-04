import { SYNQUX_SCHEMA_VERSION, type SnapshotEnvelope } from './types.js'

/**
 * snapshot 封筒の構築・直列化 (ADR-0001 Decision 11)
 *
 * どの transport / SnapshotStore でも snapshot が同一文字列になるよう、
 * core で一度だけ canonical JSON 化する。これにより
 * - ストレージ固有の直列化の罠 (undefined 落ち・空配列消失) を adapter から排除
 * - export 解析による調査手順 (SPEC-requests-sync.md Trouble Shooting) が
 *   infra 非依存の資産になる
 */

/**
 * 決定的 JSON 直列化: object の key を辞書順で出力する
 * undefined 値のプロパティは JSON.stringify の仕様どおり除去される
 */
export const canonicalStringify = (value: unknown): string =>
  JSON.stringify(sortKeysDeep(value))

const sortKeysDeep = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep)
  }

  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return Object.keys(record)
      .sort()
      .reduce<Record<string, unknown>>((sorted, key) => {
        sorted[key] = sortKeysDeep(record[key])
        return sorted
      }, {})
  }

  return value
}

export const buildSnapshotPayload = <TSynced>(
  envelope: Omit<SnapshotEnvelope<TSynced>, 'v'>,
): string =>
  canonicalStringify({
    v: SYNQUX_SCHEMA_VERSION,
    synced: envelope.synced,
    ordering: envelope.ordering,
  } satisfies SnapshotEnvelope<TSynced>)

/**
 * schema version 不一致は「検出して明示的に拒否」する (Decision 10)
 * 復元経路で新旧形式が黙って混ざると調査不能な壊れ方をするため、
 * ここで止めて運用 (exact pin / セッション中デプロイ禁止) 側に倒す
 */
export const parseSnapshotPayload = (
  payload: string,
): SnapshotEnvelope<unknown> => {
  const parsed = JSON.parse(payload) as Partial<SnapshotEnvelope<unknown>>

  if (parsed.v !== SYNQUX_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported snapshot schema version: ${String(parsed.v)} (expected ${String(SYNQUX_SCHEMA_VERSION)})`,
    )
  }

  if (
    !parsed.ordering ||
    typeof parsed.ordering.appliedSeq !== 'number' ||
    typeof parsed.ordering.epoch !== 'number' ||
    typeof parsed.ordering.applied !== 'object'
  ) {
    throw new Error(
      'Broken snapshot payload: ordering (epoch / appliedSeq / applied) is missing',
    )
  }

  return {
    v: parsed.v,
    synced: parsed.synced,
    ordering: parsed.ordering,
  }
}
