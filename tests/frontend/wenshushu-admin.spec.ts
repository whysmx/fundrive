import { expect, type Locator, type Page, test } from '@playwright/test';

const mockStorage = {
  used_space: 1_073_741_824,
  free_space: 4_294_967_296,
  total_space: 5_368_709_120,
  used_space_gb: 1,
  free_space_gb: 4,
  total_space_gb: 5,
};

const mockFiles = [
  {
    fid: 'upload_001',
    name: '产品说明.pdf',
    size: 245_760,
    upload_time: '2026-05-11 09:00:00',
    share_url: 'https://www.wenshushu.cn/f/abc123demo1',
    mgr_url: 'https://www.wenshushu.cn/mgr/abc123demo1',
  },
  {
    fid: 'upload_002',
    name: '接口截图.png',
    size: 98_304,
    upload_time: '2026-05-11 09:20:00',
    share_url: 'https://www.wenshushu.cn/f/abc123demo2',
    mgr_url: 'https://www.wenshushu.cn/mgr/abc123demo2',
  },
];

const uploadedFile = {
  fid: 'upload_003',
  name: '测试上传.txt',
  size: 12,
  upload_time: '2026-05-11 10:00:00',
  share_url: 'https://www.wenshushu.cn/f/uploaded001',
  mgr_url: 'https://www.wenshushu.cn/mgr/uploaded001',
};

test.beforeEach(async ({ page }) => {
  await mockBackendApis(page);
  await mockClipboard(page);
});

test('renders status, storage and uploaded file records from mocked APIs', async ({ page }) => {
  await page.goto('/');

  await expect(control(page, 'status-badge', /在线|已连接|正常|可用/)).toBeVisible();
  await expect(control(page, 'storage-panel', /空间|存储/)).toContainText(/1(?:\.0)?\s*GB|已用/);
  await expect(control(page, 'storage-panel', /空间|存储/)).toContainText(/4(?:\.0)?\s*GB|剩余/);

  const fileList = control(page, 'file-list', /上传记录|文件列表|历史/);
  await expect(fileList).toContainText('产品说明.pdf');
  await expect(fileList).toContainText('接口截图.png');
  await expect(fileList).toContainText('https://www.wenshushu.cn/f/abc123demo1');
});

test('uploads a selected file and appends the returned share link', async ({ page }) => {
  await page.goto('/');

  const fileInput = page.getByTestId('upload-input').or(page.locator('input[type="file"]')).first();
  await fileInput.setInputFiles({
    name: '测试上传.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('hello upload'),
  });

  await page.getByTestId('upload-button').click();

  await expect(page.getByTestId('upload-records')).toContainText('测试上传.txt');
  await expect(page.getByText('https://www.wenshushu.cn/f/uploaded001')).toBeVisible();
});

test('downloads by share url and shows a successful result', async ({ page }) => {
  await page.goto('/');

  await fillControl(
    page,
    'download-url-input',
    /分享链接|下载链接|链接/,
    'https://www.wenshushu.cn/f/abc123demo1',
  );
  await clickControl(page, 'download-button', /下载/);

  await expect(control(page, 'download-result', /下载/)).toContainText(/downloaded-product\.pdf|下载成功|已开始/);
});

test('searches uploaded records and can copy the returned share link', async ({ page }) => {
  await page.goto('/');

  await fillControl(page, 'search-input', /搜索|关键词/, '截图');
  await clickControl(page, 'search-button', /搜索/);

  const results = page.getByTestId('search-results');
  await expect(results).toContainText('接口截图.png');
  await expect(results).not.toContainText('产品说明.pdf');

  await results.getByTestId('copy-link-button').click();
  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem('__copiedText')))
    .toBe('https://www.wenshushu.cn/f/abc123demo2');
});

async function mockBackendApis(page: Page) {
  let files = [...mockFiles];

  await page.route('**/api/status', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, logged_in: true, service: 'wenshushu' }),
    });
  });

  await page.route('**/api/storage', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(mockStorage),
    });
  });

  await page.route('**/api/files', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ files }),
    });
  });

  await page.route('**/api/search**', async route => {
    const url = new URL(route.request().url());
    const body = await tryReadJson(route.request().postData() || '');
    const keyword = String(url.searchParams.get('keyword') || url.searchParams.get('q') || body.keyword || body.q || '')
      .toLowerCase();
    const results = files.filter(file => file.name.toLowerCase().includes(keyword));

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ files: results, results }),
    });
  });

  await page.route('**/api/upload**', async route => {
    files = [...files, uploadedFile];
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, file: uploadedFile, share_url: uploadedFile.share_url }),
    });
  });

  await page.route('**/api/download**', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        filename: 'downloaded-product.pdf',
        message: '下载成功',
      }),
    });
  });
}

async function tryReadJson(text: string): Promise<Record<string, unknown>> {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

async function mockClipboard(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          window.localStorage.setItem('__copiedText', text);
        },
        readText: async () => window.localStorage.getItem('__copiedText') || '',
      },
    });
  });
}

function control(page: Page, testId: string, fallbackText: RegExp): Locator {
  return page.getByTestId(testId).or(page.getByText(fallbackText).locator('xpath=ancestor-or-self::*[1]')).first();
}

async function clickControl(page: Page, testId: string, name: RegExp) {
  await page.getByTestId(testId).or(page.getByRole('button', { name })).first().click();
}

async function fillControl(page: Page, testId: string, label: RegExp, value: string) {
  const input = page
    .getByTestId(testId)
    .or(page.getByLabel(label))
    .or(page.getByPlaceholder(label))
    .first();

  await input.fill(value);
}
