import pkg from "../tests/frontend/node_modules/playwright/index.js";

const { chromium } = pkg;

const [filePath, desiredName] = process.argv.slice(2);

if (!filePath || !desiredName) {
  console.log(JSON.stringify({ ok: false, error: "missing arguments" }));
  process.exit(1);
}

const shareRegex = /https:\/\/[^\s]+\/f\/([A-Za-z0-9]+)/;
const mgrRegex = /https:\/\/www\.wenshushu\.cn\/mgr\/([A-Za-z0-9]+)/;

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ locale: "zh-CN" });

  try {
    await page.goto("https://www.wenshushu.cn/", {
      waitUntil: "networkidle",
      timeout: 90000,
    });

    const token = await page.evaluate(() => {
      return (
        window.localStorage.getItem("login_token") ||
        window.localStorage.getItem("guest_token") ||
        ""
      );
    });

    const chooserPromise = page.waitForEvent("filechooser", { timeout: 30000 });
    await page.getByRole("button", { name: /选择文件/ }).first().click();
    const chooser = await chooserPromise;
    await chooser.setFiles(filePath);

    await page.waitForTimeout(1500);
    const filenameInput = page.locator("text=" + desiredName).first();
    await filenameInput.waitFor({ timeout: 15000 });

    const addFileButton = page.getByRole("button", { name: /添加文件/ });
    if (await addFileButton.count()) {
      await addFileButton.first().click().catch(() => {});
    }

    await page.getByRole("button", { name: /^发送$/ }).click();
    await page.getByText(/文件发送成功|已全部发送成功/).first().waitFor({
      timeout: 120000,
    });

    const bodyText = await page.evaluate(() => document.body.innerText);
    const shareMatch = bodyText.match(shareRegex);
    const mgrTidMatch = bodyText.match(/查看\s*\/\s*管理文件/);

    let mgrUrl = "";
    const mgrButton = page.getByText("查看 / 管理文件").first();
    if (await mgrButton.count()) {
      const popupPromise = page.context().waitForEvent("page", { timeout: 15000 }).catch(() => null);
      await mgrButton.click().catch(() => {});
      const popup = await popupPromise;
      if (popup) {
        await popup.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
        mgrUrl = popup.url();
        await popup.close().catch(() => {});
      }
    }

    if (!mgrUrl) {
      const currentLinks = await page.locator("a").evaluateAll((els) =>
        els.map((el) => el.getAttribute("href") || "").filter(Boolean)
      );
      const mgrCandidate = currentLinks.find((href) => mgrRegex.test(href));
      if (mgrCandidate) mgrUrl = mgrCandidate;
    }

    const shareUrl = shareMatch ? shareMatch[0] : "";
    if (!shareUrl) {
      throw new Error("share url not found");
    }

    let fid = "";
    const fidMatch = shareUrl.match(/\/f\/([A-Za-z0-9]+)/);
    if (fidMatch) fid = fidMatch[1];

    console.log(
      JSON.stringify({
        ok: true,
        fid,
        task_id: fid,
        owner_token: token,
        share_url: shareUrl,
        mgr_url: mgrUrl,
        has_mgr_entry: Boolean(mgrTidMatch),
      })
    );
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.log(
    JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  );
  process.exit(1);
});
