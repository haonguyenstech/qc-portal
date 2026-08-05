import type { TestCaseFormat } from '@/lib/api'

/** Build the on-disk path of a test-case version (mirrors the server layout). */
export function testcaseRelPath(
  folder: string,
  version: number,
  format: TestCaseFormat = 'markdown',
): string {
  if (version === 0) return `testing/tickets/${folder}/testcases.md`
  const ext = format === 'csv' ? 'csv' : 'md'
  return `testing/tickets/${folder}/testcases/v${version}.${ext}`
}
