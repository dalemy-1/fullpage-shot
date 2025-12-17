import { chromium } from "playwright";

const url = process.argv[2];
if (!url) {
  console.log('用法：node shot.mjs "<URL>" [输出文件名.png]');
  process.exit(1);
}
const out = (process.argv[3] || "fullpage.png").replace(/[<>:"/\\|?*]/g, "_");

const browser = await chromium.launch({
  channel: "chrome",
  headless: false
});

const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2
});

const page = await context.newPage();
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });

// 给 SPA（#/）一点渲染时间
await page.waitForTimeout(3000);

await page.screenshot({ path: out, fullPage: true });

await browser.close();
console.log("已导出：", out);
