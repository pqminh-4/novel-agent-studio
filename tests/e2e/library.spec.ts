import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

let app: ElectronApplication | null = null
let dataDirectory = ''

test.afterEach(async () => {
  await app?.close()
  app = null
  if (dataDirectory) rmSync(dataDirectory, { recursive: true, force: true })
  dataDirectory = ''
})

async function launch(size: { width: number; height: number }): Promise<{ page: Page; errors: string[] }> {
  dataDirectory = mkdtempSync(join(tmpdir(), 'novel-agent-playwright-'))
  app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      NOVEL_AGENT_USER_DATA_DIRECTORY: dataDirectory
    }
  })
  const page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }, nextSize) => {
    BrowserWindow.getAllWindows()[0]?.setSize(nextSize.width, nextSize.height)
  }, size)
  await page.waitForTimeout(150)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  await expect(page.getByRole('heading', { name: 'Thư viện sáng tác' })).toBeVisible()
  return { page, errors }
}

async function assertInsideViewport(page: Page, selector: string): Promise<void> {
  const element = page.locator(selector).first()
  await expect(element).toBeVisible()
  const box = await element.boundingBox()
  const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
  expect(box).not.toBeNull()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.y).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1)
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1)
}

for (const size of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }]) {
  test(`Dashboard và Series Studio không chồng lấn ở ${size.width}x${size.height}`, async ({}, testInfo) => {
    const { page, errors } = await launch(size)
    await assertInsideViewport(page, '.library-header')
    await assertInsideViewport(page, '.library-toolbar')

    await page.getByRole('button', { name: 'Series mới' }).click()
    await page.getByLabel('Tên Series').fill('Biên niên sử Mưa Sao')
    await page.getByLabel('Mô tả').fill('Một Series mới được xây dựng trước khi có Tập 1.')
    await page.getByRole('button', { name: 'Lưu', exact: true }).click()

    await expect(page.getByRole('heading', { name: 'Biên niên sử Mưa Sao' })).toBeVisible()
    await assertInsideViewport(page, '.concept-chat')
    await assertInsideViewport(page, '.concept-brief')
    await page.screenshot({ path: testInfo.outputPath(`series-concept-${size.width}x${size.height}.png`), fullPage: false })

    await page.getByRole('button', { name: 'Xem trước Tập 1' }).click()
    await expect(page.getByRole('heading', { name: 'Tạo Tập 1' })).toBeVisible()
    await assertInsideViewport(page, '.first-book-dialog')
    if (size.width === 1440) {
      await page.getByLabel('Tên Tập 1').fill('Bầu trời sau cơn mưa')
      await page.getByRole('button', { name: 'Tạo và mở Tập 1' }).click()
      await expect(page.getByRole('tab', { name: 'Trò chuyện với Đạo diễn' })).toHaveAttribute('aria-selected', 'true')
      await expect(page.getByText(/Định hướng cấp Series.*đã được chuyển thành Tập 1/)).toBeVisible()
    } else {
      await page.getByRole('button', { name: 'Đóng' }).click()
    }

    await page.getByRole('button', { name: 'Thư viện sáng tác' }).click()
    await expect(page.getByRole('heading', { name: 'Thư viện sáng tác' })).toBeVisible()
    await expect(page.getByText('Biên niên sử Mưa Sao', { exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath(`library-${size.width}x${size.height}.png`), fullPage: false })
    expect(errors).toEqual([])
  })
}
