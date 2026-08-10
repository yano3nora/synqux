type Divergence = {
  path: string
  expected: unknown
  actual: unknown
}

/**
 * JSON 正規化済みの 2 値を決定的な順序で比較し、最初の差分だけを返す。
 * 診断結果が object の挿入順に左右されないよう、キーは辞書順で走査する。
 */
export const findFirstDivergence = (
  expected: unknown,
  actual: unknown,
): Divergence | null => findFirstDivergenceAt(expected, actual, '')

const findFirstDivergenceAt = (
  expected: unknown,
  actual: unknown,
  path: string,
): Divergence | null => {
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) {
      return { path, expected, actual }
    }

    const sharedLength = Math.min(expected.length, actual.length)
    for (let index = 0; index < sharedLength; index += 1) {
      const divergence = findFirstDivergenceAt(
        expected[index],
        actual[index],
        `${path}[${String(index)}]`,
      )
      if (divergence) {
        return divergence
      }
    }

    if (expected.length !== actual.length) {
      const index = sharedLength
      return {
        path: `${path}[${String(index)}]`,
        expected: expected[index],
        actual: actual[index],
      }
    }

    return null
  }

  if (isJsonObject(expected) || isJsonObject(actual)) {
    if (!isJsonObject(expected) || !isJsonObject(actual)) {
      return { path, expected, actual }
    }

    const keys = [
      ...new Set([...Object.keys(expected), ...Object.keys(actual)]),
    ].sort()

    for (const key of keys) {
      const childPath = path === '' ? key : `${path}.${key}`
      const expectedHasKey = Object.hasOwn(expected, key)
      const actualHasKey = Object.hasOwn(actual, key)

      // JSON 正規化済みなら undefined 値は存在しないため、undefined は欠落を表す。
      if (!expectedHasKey || !actualHasKey) {
        return {
          path: childPath,
          expected: expectedHasKey ? expected[key] : undefined,
          actual: actualHasKey ? actual[key] : undefined,
        }
      }

      const divergence = findFirstDivergenceAt(
        expected[key],
        actual[key],
        childPath,
      )
      if (divergence) {
        return divergence
      }
    }

    return null
  }

  return expected !== actual ? { path, expected, actual } : null
}

const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object'
