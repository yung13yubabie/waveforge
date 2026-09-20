import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory()
    ? walk(join(dir, e.name)) : /\.(m?js)$/.test(e.name) ? [join(dir, e.name)] : [])
}
const files = [...walk('src'), ...walk('tests'), ...walk('scripts'),
  'vite.config.js', 'vitest.config.js', 'playwright.config.js', 'playwright.production.config.js']
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (result.status !== 0) { process.stderr.write(result.stderr || String(result.error)); process.exit(1) }
}
console.log(`Syntax checked ${files.length} JavaScript files`)
