import { createHash, randomUUID } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const packageJson = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
const lockfile = await readFile(new URL('pnpm-lock.yaml', root), 'utf8')
const releaseDirectory = new URL('release/', root)
const releasePath = fileURLToPath(releaseDirectory)

const packageBlock = lockfile.split(/^packages:\s*$/m)[1]?.split(/^snapshots:\s*$/m)[0] ?? ''
const components = []
const seen = new Set()

for (const match of packageBlock.matchAll(/^  (['"]?)(.+?)\1:\s*$/gm)) {
  const packageKey = match[2]
  const separator = packageKey.lastIndexOf('@')
  if (separator <= 0) continue
  const name = packageKey.slice(0, separator)
  const version = packageKey.slice(separator + 1)
  if (!name || !version || version.includes('(')) continue
  const reference = `pkg:npm/${encodePackageName(name)}@${version}`
  if (seen.has(reference)) continue
  seen.add(reference)
  components.push({ type: 'library', name, version, purl: reference, 'bom-ref': reference })
}

components.sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version))

const sbom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.6',
  serialNumber: `urn:uuid:${randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    component: {
      type: 'application',
      name: packageJson.name,
      version: packageJson.version,
      'bom-ref': `pkg:npm/${packageJson.name}@${packageJson.version}`
    },
    tools: [{ vendor: 'Novel Agent Studio', name: 'generate-release-metadata', version: '1' }]
  },
  components
}

const sbomName = `novel-agent-studio-${packageJson.version}.sbom.cdx.json`
await writeFile(new URL(`release/${sbomName}`, root), `${JSON.stringify(sbom, null, 2)}\n`, 'utf8')

const files = (await readdir(releaseDirectory, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name !== 'SHA256SUMS.txt')
  .map((entry) => entry.name)
  .sort()

const checksums = []
for (const name of files) {
  const content = await readFile(join(releasePath, name))
  const hash = createHash('sha256').update(content).digest('hex')
  checksums.push(`${hash}  ${name}`)
}
await writeFile(new URL('release/SHA256SUMS.txt', root), `${checksums.join('\n')}\n`, 'utf8')

function encodePackageName(name) {
  return name.startsWith('@') ? name.replace('/', '%2F') : name
}
