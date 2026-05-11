import { expect, type Locator, type Page, test } from '@playwright/test';

const mockFiles = [
  {
    id: 'upload_001',
    fid: 'upload_001',
    name: '产品说明.pdf',
    size: 245_760,
    uploader_ip: '192.168.1.20',
    user: '张三',
    remark: '发给客户确认',
    upload_time: '2026-05-11 09:00:00',
    share_url: 'https://www.wenshushu.cn/f/abc123demo1',
    mgr_url: 'https://www.wenshushu.cn/mgr/abc123demo1',
  },
  {
    id: 'upload_002',
    fid: 'upload_002',
    name: '接口截图.png',
    size: 98_304,
    uploader_ip: '192.168.1.21',
    user: '李四',
    remark: '',
    upload_time: '2026-05-11 09:20:00',
    share_url: 'https://www.wenshushu.cn/f/abc123demo2',
    mgr_url: 'https://www.wenshushu.cn/mgr/abc123demo2',
  },
];

const uploadedFile = {
  id: 'upload_003',
  fid: 'upload_003',
  name: '测试上传.txt',
  size: 12,
  uploader_ip: '192.168.1.22',
  user: '王五',
  remark: '自动化上传',
  upload_time: '2026-05-11 10:00:00',
  share_url: 'https://www.wenshushu.cn/f/uploaded001',
  mgr_url: 'https://www.wenshushu.cn/mgr/uploaded001',
};

const mockMappings = [{ ip: '192.168.1.20', user: '张三' }];

test.beforeEach(async ({ page }) => {
  await mockBackendApis(page);
  await mockClipboard(page);
});

test('renders status and uploaded file records from mocked APIs', async ({ page }) => {
  await page.goto('/');

  await expect(control(page, 'status-badge', /在线|已连接|正常|可用/)).toBeVisible();

  const fileList = control(page, 'file-list', /上传记录|文件列表|历史/);
  await expect(fileList).toContainText('产品说明.pdf');
  await expect(fileList).toContainText('张三');
  await expect(fileList).toContainText('192.168.1.20');
  await expect(page.locator('[data-remark-id="upload_001"]')).toHaveValue('发给客户确认');
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

test('searches uploaded records', async ({ page }) => {
  await page.goto('/');

  await fillControl(page, 'search-input', /搜索|关键词/, '截图');
  await clickControl(page, 'search-button', /搜索/);

  const results = page.getByTestId('search-results');
  await expect(results).toContainText('接口截图.png');
  await expect(results).not.toContainText('产品说明.pdf');
  await expect(results.getByTestId('copy-link-button')).toHaveCount(0);
});

test('shows users in the records table and filters records by selected user', async ({ page }) => {
  await page.goto('/');

  const userFilter = page.getByTestId('user-filter');
  await expect(userFilter).toContainText('张三');
  await expect(userFilter).toContainText('李四');

  await userFilter.selectOption('李四');

  const results = page.getByTestId('search-results');
  await expect(results).toContainText('接口截图.png');
  await expect(results).toContainText('李四');
  await expect(results).not.toContainText('产品说明.pdf');
  await expect(results).not.toContainText('张三');
});

test('saves and deletes IP to user mappings', async ({ page }) => {
  await page.goto('/');

  const mappingList = page.getByTestId('mapping-list');
  await expect(mappingList).toContainText('192.168.1.20 = 张三');

  await page.locator('#mapping-ip').fill('192.168.1.23');
  await page.locator('#mapping-user').fill('赵六');
  await page.locator('#mapping-save-button').click();

  await expect(mappingList).toContainText('192.168.1.23 = 赵六');
  await expect(page.getByTestId('user-filter')).toContainText('赵六');

  await mappingList.getByRole('button', { name: '删除 192.168.1.23' }).click();

  await expect(mappingList).not.toContainText('192.168.1.23 = 赵六');
});

test('saves an edited remark for an uploaded record', async ({ page }) => {
  await page.goto('/');

  const remarkRequest = page.waitForRequest(
    request => request.url().includes('/api/files/upload_001/remark') && request.method() === 'POST',
  );
  const remarkInput = page.locator('[data-remark-id="upload_001"]');
  await remarkInput.fill('已经线下确认');
  await remarkInput.dispatchEvent('change');

  const request = await remarkRequest;
  expect(JSON.parse(request.postData() || '{}')).toEqual({ remark: '已经线下确认' });
  await expect(page.locator('#toast')).toContainText('备注已保存');
});

test('copies an overwrite download command for an uploaded record', async ({ page }) => {
  await page.goto('/');

  const results = page.getByTestId('search-results');
  await expect(results.getByTestId('copy-command-button').first()).toHaveText('复制下载命令');
  await results.getByTestId('copy-command-button').first().click();

  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem('__copiedText')))
    .toContain('rm -f "/home/forlinx/产品说明.pdf" && wget -O "/home/forlinx/产品说明.pdf"');
});

async function mockBackendApis(page: Page) {
  let files = [...mockFiles];
  let mappings = [...mockMappings];

  await page.route('**/api/status', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, logged_in: true, service: 'wenshushu' }),
    });
  });

  await page.route('**/api/files**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname !== '/api/files') {
      await route.fallback();
      return;
    }

    const url = new URL(route.request().url());
    const user = url.searchParams.get('user') || '';
    const filteredFiles = filterFiles(files, '', user);

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, files: filteredFiles, users: listUsers(files, mappings) }),
    });
  });

  await page.route('**/api/search**', async route => {
    const url = new URL(route.request().url());
    const body = await tryReadJson(route.request().postData() || '');
    const keyword = String(url.searchParams.get('keyword') || url.searchParams.get('q') || body.keyword || body.q || '')
      .toLowerCase();
    const user = String(url.searchParams.get('user') || body.user || '');
    const results = filterFiles(files, keyword, user);

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, files: results, results, users: listUsers(files, mappings) }),
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

  await page.route('**/api/ip-users', async route => {
    const method = route.request().method();
    if (method === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, mappings, users: listUsers(files, mappings) }),
      });
      return;
    }

    if (method === 'POST') {
      const body = await tryReadJson(route.request().postData() || '');
      const mapping = { ip: String(body.ip || ''), user: String(body.user || '') };
      mappings = [...mappings.filter(item => item.ip !== mapping.ip), mapping];
      files = files.map(file =>
        file.uploader_ip === mapping.ip && (!file.user || file.user === file.uploader_ip)
          ? { ...file, user: mapping.user }
          : file,
      );
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, mapping, mappings, users: listUsers(files, mappings) }),
      });
      return;
    }

    await route.fallback();
  });

  await page.route('**/api/ip-users/*', async route => {
    if (route.request().method() !== 'DELETE') {
      await route.fallback();
      return;
    }

    const ip = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop() || '');
    mappings = mappings.filter(item => item.ip !== ip);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, mappings, users: listUsers(files, mappings) }),
    });
  });

  await page.route('**/api/files/*/remark', async route => {
    const body = await tryReadJson(route.request().postData() || '');
    const parts = new URL(route.request().url()).pathname.split('/');
    const uploadId = decodeURIComponent(parts[parts.length - 2] || '');
    const remark = String(body.remark || '');
    let updatedFile = files.find(file => file.id === uploadId || file.fid === uploadId);
    files = files.map(file => {
      if (file.id !== uploadId && file.fid !== uploadId) return file;
      updatedFile = { ...file, remark };
      return updatedFile;
    });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, file: updatedFile }),
    });
  });

  await page.route('**/api/download-command/**', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        command:
          'rm -f "/home/forlinx/产品说明.pdf" && wget -O "/home/forlinx/产品说明.pdf" "https://down.wss.show/demo"',
      }),
    });
  });
}

function filterFiles(files: typeof mockFiles, keyword: string, user: string) {
  return files.filter(file => {
    const keywordMatched =
      !keyword ||
      file.name.toLowerCase().includes(keyword) ||
      file.share_url.toLowerCase().includes(keyword) ||
      file.remark.toLowerCase().includes(keyword) ||
      file.user.toLowerCase().includes(keyword);
    const userMatched = !user || file.user === user;
    return keywordMatched && userMatched;
  });
}

function listUsers(files: typeof mockFiles, mappings: typeof mockMappings) {
  return Array.from(new Set([...files.map(file => file.user), ...mappings.map(mapping => mapping.user)].filter(Boolean))).sort();
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
