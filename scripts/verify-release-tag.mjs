import { readFile } from 'node:fs/promises'

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const rawTag = process.argv.slice(2).find((argument) => argument !== '--') ?? process.env.GITHUB_REF_NAME

if (!rawTag) {
  console.error('Thiếu release tag. Truyền tag dạng vX.Y.Z hoặc đặt GITHUB_REF_NAME.')
  process.exitCode = 1
} else {
  const expectedTag = `v${packageJson.version}`
  if (rawTag !== expectedTag) {
    console.error(`Release tag không khớp: nhận ${rawTag}, cần ${expectedTag} theo package.json.`)
    process.exitCode = 1
  } else {
    console.log(`Release tag hợp lệ: ${rawTag}`)
  }
}
