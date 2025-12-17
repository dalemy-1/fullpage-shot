import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const url = process.argv[2];
if (!url) {
  console.log('用法：node grid_4x5.mjs "<URL或file:///...>" [输出目录]');
  process.exit(1);
}

const OUT_DIR = (process.argv[3] || "grid_pages_v3").trim();
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const WIDTH = Number(process.env.WIDTH || 1440);
const BASE_HEIGHT = Number(process.env.HEIGHT || 3200);
const DPR = Number(process.env.DPR || 2);

// 每张图最多 5 行（4列固定）
const ROWS_PER_SHOT = 5;

// 等待参数（慢就调大）
const WAIT_AFTER_GOTO_MS = Number(process.env.WAIT_AFTER_GOTO_MS || 5000);
const WAIT_AFTER_SCROLL_MS = Number(process.env.WAIT_AFTER_SCROLL_MS || 1600);
const MAX_SCROLL_ROUNDS = Number(process.env.MAX_SCROLL_ROUNDS || 260);
const STABLE_ROUNDS_TO_STOP = Number(process.env.STABLE_ROUNDS_TO_STOP || 7);

// “确保渲染”轮数
const ENSURE_ROUNDS = Number(process.env.ENSURE_ROUNDS || 40);

// 你的卡片选择器
const ITEM_SEL = ".product-item";

const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({
  viewport: { width: WIDTH, height: BASE_HEIGHT },
  deviceScaleFactor: DPR,
});
const page = await context.newPage();

await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
await page.waitForTimeout(WAIT_AFTER_GOTO_MS);

// 1) 隐藏页头页尾 + 强制 4 列 grid
await page.addStyleTag({
  content: `
    .title, .search, .banner, .van-tabbar { display: none !important; }
    .van-list { margin-top: 0 !important; }
    .product-list{
      display: grid !important;
      grid-template-columns: repeat(4, 1fr) !important;
      gap: 14px !important;
      align-items: stretch !important;
    }
    .product-item{ width: 100% !important; }
  `,
});

await page.waitForSelector(ITEM_SEL, { timeout: 60000 });

// 2) 尽量把所有商品加载出来（count 稳定则停止）
let stable = 0;
let lastCount = -1;
for (let r = 0; r < MAX_SCROLL_ROUNDS; r++) {
  const count = await page.locator(ITEM_SEL).count();
  stable = (count === lastCount) ? stable + 1 : 0;
  lastCount = count;
  if (stable >= STABLE_ROUNDS_TO_STOP) break;

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(WAIT_AFTER_SCROLL_MS);
  await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
}

await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(800);

let total = await page.locator(ITEM_SEL).count();
console.log("商品卡片数量：", total);
if (total === 0) {
  console.log("未找到商品卡片。");
  await browser.close();
  process.exit(1);
}

// 工具：确保至少渲染到某个 index（避免最后页/某页只出现 4 行）
async function ensureRendered(minCount) {
  for (let k = 0; k < ENSURE_ROUNDS; k++) {
    const c = await page.locator(ITEM_SEL).count();
    if (c >= minCount) return true;
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(WAIT_AFTER_SCROLL_MS);
  }
  return false;
}

// 工具：根据 startIndex 计算“本次要截的行段”——返回 segment 的 bbox（视口坐标）
// 规则：从 startIndex 开始，取连续最多 5 行；如果到最后不足 5 行，则把剩余所有行一次截完（不会拆成一行图）
async function computeRowSegmentBox(startIndex) {
  return await page.evaluate(({ sel, start, rowsWanted }) => {
    const items = Array.from(document.querySelectorAll(sel));
    if (start >= items.length) return null;

    // 收集从 start 开始的元素 rect（视口坐标）并按 top 聚类成“行”
    const rects = [];
    for (let i = start; i < items.length; i++) {
      const r = items[i].getBoundingClientRect();
      rects.push({ i, top: r.top, left: r.left, right: r.right, bottom: r.bottom });
    }

    // 行聚类：top 相近认为同一行
    const tol = 6; // 容差
    const rows = [];
    for (const it of rects) {
      let row = rows.find(x => Math.abs(x.top - it.top) <= tol);
      if (!row) {
        row = { top: it.top, items: [] };
        rows.push(row);
      }
      row.items.push(it);
    }
    rows.sort((a, b) => a.top - b.top);

    // 目标行数：非最后页按 rowsWanted；但如果后面已接近尾部且行数不足，就把剩余行一次截完
    const takeRows = Math.min(rowsWanted, rows.length);

    // 计算 takeRows 行的 bbox
    const usedRows = rows.slice(0, takeRows);
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    let lastIndex = start;

    for (const row of usedRows) {
      for (const it of row.items) {
        left = Math.min(left, it.left);
        top = Math.min(top, it.top);
        right = Math.max(right, it.right);
        bottom = Math.max(bottom, it.bottom);
        lastIndex = Math.max(lastIndex, it.i);
      }
    }

    // padding
    const pad = 10;
    left = Math.max(0, left - pad);
    top = Math.max(0, top - pad);
    right = right + pad;
    bottom = bottom + pad;

    return {
      x: left,
      y: top,
      w: right - left,
      h: bottom - top,
      // 下一次从 lastIndex+1 开始（保证不会把“剩余一行”拆出来）
      nextStart: lastIndex + 1,
      rowsFound: rows.length,
      takeRows
    };
  }, { sel: ITEM_SEL, start: startIndex, rowsWanted: ROWS_PER_SHOT });
}

// 工具：把当前 segment 的顶部滚到视口顶部附近，确保 clip 不会切掉底部
async function scrollSegmentToTop(seg) {
  // seg.y 是视口坐标，转换成页面绝对滚动：当前 scrollY + seg.y - 8
  await page.evaluate((yy) => {
    const target = window.scrollY + yy - 8;
    window.scrollTo(0, Math.max(0, target));
  }, seg.y);
  await page.waitForTimeout(700);
}

// 主循环：按“行段”连续输出截图
let start = 0;
let shotNo = 1;

while (start < total) {
  // 确保渲染到 start+1（至少 start 这个元素存在）
  await ensureRendered(start + 1);

  // 把 start 元素滚进视口
  await page.locator(ITEM_SEL).nth(start).scrollIntoViewIfNeeded();
  await page.waitForTimeout(700);

  // 先算 segment
  let seg = await computeRowSegmentBox(start);
  if (!seg) break;

  // 关键：滚动让 segment 顶部靠近视口顶部
  await scrollSegmentToTop(seg);

  // 重新计算（滚动后坐标会变化）
  seg = await computeRowSegmentBox(start);
  if (!seg) break;

  // 如果 segment 高度仍大于视口高度，则临时拉高 viewport（彻底解决“第5行不完整”）
  const vp = page.viewportSize();
  if (seg.y + seg.h > vp.height - 6) {
    const needH = Math.min(9000, Math.ceil(seg.y + seg.h + 40));
    await page.setViewportSize({ width: WIDTH, height: needH });
    await page.waitForTimeout(300);

    // 再滚一次到顶部并重算，保证 clip 完全落在视口内
    seg = await computeRowSegmentBox(start);
    await scrollSegmentToTop(seg);
    seg = await computeRowSegmentBox(start);
  }

  const outPath = path.join(OUT_DIR, `page_${String(shotNo).padStart(3, "0")}.png`);
  await page.screenshot({
    path: outPath,
    clip: {
      x: Math.max(0, Math.floor(seg.x)),
      y: Math.max(0, Math.floor(seg.y)),
      width: Math.max(1, Math.floor(seg.w)),
      height: Math.max(1, Math.floor(seg.h)),
    },
  });

  console.log(`输出: ${outPath} （start=${start} -> next=${seg.nextStart}，行=${seg.takeRows}）`);

  // 下一段从 seg.nextStart 开始（保证最后不足 5 行也只会出一张，不会再拆一行）
  start = seg.nextStart;
  shotNo += 1;

  // 恢复基础视口，避免后续布局异常
  await page.setViewportSize({ width: WIDTH, height: BASE_HEIGHT });
  await page.waitForTimeout(150);

  // total 可能在少数页面仍会增长，更新一次
  total = await page.locator(ITEM_SEL).count();
}

await browser.close();
console.log("完成。输出目录：", OUT_DIR);
