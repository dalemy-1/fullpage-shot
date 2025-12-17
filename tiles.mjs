import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import sharp from "sharp";

const url = process.argv[2];
if (!url) {
  console.log('用法：node tiles.mjs "<URL>" [输出文件名.png]');
  process.exit(1);
}
const outName = (process.argv[3] || "fullpage_stitched.png").replace(/[<>:"/\\|?*]/g, "_");

// 参数（可用环境变量覆盖）
const WIDTH = Number(process.env.WIDTH || 1440);
const HEIGHT = Number(process.env.HEIGHT || 900);
const DPR = Number(process.env.DPR || 2);
const OVERLAP = Number(process.env.OVERLAP || 160); // 重叠，避免漏行/拼接断裂
const KEEP_FIXED = (process.env.KEEP_FIXED || "") === "1";

// 无限下拉/分页加载兜底参数
const WAIT_AFTER_SCROLL_MS = Number(process.env.WAIT_AFTER_SCROLL_MS || 1300);
const WAIT_AT_BOTTOM_MS = Number(process.env.WAIT_AT_BOTTOM_MS || 3500);
const STABLE_ROUNDS_TO_STOP = Number(process.env.STABLE_ROUNDS_TO_STOP || 5); // 连续不增长轮数
const MAX_TILES = Number(process.env.MAX_TILES || 1500);

const tilesDir = path.join(process.cwd(), "tiles");
if (!fs.existsSync(tilesDir)) fs.mkdirSync(tilesDir);

// 清理旧 tiles（可选）
for (const f of fs.readdirSync(tilesDir)) {
  if (f.startsWith("tile_") && f.endsWith(".png")) {
    try { fs.unlinkSync(path.join(tilesDir, f)); } catch {}
  }
}

const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({
  viewport: { width: WIDTH, height: HEIGHT },
  deviceScaleFactor: DPR,
});
const page = await context.newPage();

await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
// SPA 给足渲染时间
await page.waitForTimeout(5000);

// 选出“最可能的滚动容器”（解决：内部容器滚动导致 fullPage 不全）
const scrollerInfo = await page.evaluate(() => {
  function isScrollable(el) {
    const st = getComputedStyle(el);
    const oy = st.overflowY;
    return (oy === "auto" || oy === "scroll") && el.scrollHeight - el.clientHeight > 300;
  }

  let best = document.scrollingElement || document.documentElement;
  let bestDelta = (best.scrollHeight - best.clientHeight) || 0;

  const els = Array.from(document.querySelectorAll("*"));
  for (const el of els) {
    if (!el || !(el instanceof HTMLElement)) continue;
    if (el.clientHeight < 200) continue;
    if (!isScrollable(el)) continue;

    const delta = el.scrollHeight - el.clientHeight;
    if (delta > bestDelta) {
      best = el;
      bestDelta = delta;
    }
  }

  window.__shot_scroller = best;
  return {
    tag: best.tagName,
    id: best.id || "",
    className: best.className?.toString?.() || "",
    scrollHeight: best.scrollHeight,
    clientHeight: best.clientHeight,
    delta: bestDelta,
  };
});

console.log("使用滚动容器：", scrollerInfo);

// 可选：隐藏 fixed/sticky（避免每个分段重复出现顶部/底部导航）
if (!KEEP_FIXED) {
  await page.evaluate(() => {
    let n = 0;
    for (const el of Array.from(document.querySelectorAll("*"))) {
      const st = getComputedStyle(el);
      if (st.position === "fixed" || st.position === "sticky") {
        const r = el.getBoundingClientRect();
        if (r.height >= 40 && r.width >= 200) {
          el.setAttribute("data-shot-hidden", "1");
          el.style.visibility = "hidden";
          n += 1;
        }
      }
    }
    return n;
  });
}

async function getMetrics() {
  return await page.evaluate(() => {
    const el = window.__shot_scroller || document.scrollingElement;
    return {
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    };
  });
}

async function setScrollTop(y) {
  await page.evaluate((yy) => {
    const el = window.__shot_scroller || document.scrollingElement;
    el.scrollTop = yy;
  }, y);
}

// -------------------- 分段截图（支持无限下拉） --------------------
const tilePaths = [];

let m0 = await getMetrics();
let scrollHeight = m0.scrollHeight;
let clientHeight = m0.clientHeight;

// 步进：可视高度 - 重叠
let step = Math.max(120, clientHeight - OVERLAP);

let y = 0;
let i = 0;

let stableBottomRounds = 0;
let lastScrollHeight = 0;

while (true) {
  const m = await getMetrics();
  scrollHeight = m.scrollHeight;
  clientHeight = m.clientHeight;

  // clientHeight 有时会变化，动态更新 step
  step = Math.max(120, clientHeight - OVERLAP);

  const maxY = Math.max(0, scrollHeight - clientHeight);

  // 检测高度变化
  if (scrollHeight !== lastScrollHeight) {
    stableBottomRounds = 0;
    lastScrollHeight = scrollHeight;
  }

  if (y > maxY) y = maxY;

  await setScrollTop(y);

  // 等待渲染/加载（SPA、图片、接口数据）
  await page.waitForTimeout(WAIT_AFTER_SCROLL_MS);
  await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});

  const tilePath = path.join(tilesDir, `tile_${String(i).padStart(5, "0")}.png`);
  await page.screenshot({ path: tilePath, fullPage: false });
  tilePaths.push(tilePath);

  // 到达当前底部：等待看看是否会继续加载变长
  if (y >= maxY) {
    await page.waitForTimeout(WAIT_AT_BOTTOM_MS);

    const m2 = await getMetrics();
    const grew = m2.scrollHeight > scrollHeight + 80; // 增长阈值

    if (grew) {
      // 继续加载了：保持在底部，下一轮会得到新的 maxY
      lastScrollHeight = m2.scrollHeight;
      stableBottomRounds = 0;
      // y 仍然是旧底部，下一轮会自动继续往下截
    } else {
      stableBottomRounds += 1;
      if (stableBottomRounds >= STABLE_ROUNDS_TO_STOP) break;
    }
  } else {
    // 正常向下推进
    y += step;
  }

  i += 1;
  if (i >= MAX_TILES) break;
}

await browser.close();

// -------------------- 拼接 --------------------
// 将每张 tile 的顶部裁掉 OVERLAP，避免重复
if (tilePaths.length === 0) {
  console.log("没有生成任何分片截图，无法拼接。");
  process.exit(1);
}

const images = [];
for (let idx = 0; idx < tilePaths.length; idx++) {
  const p = tilePaths[idx];
  const img = sharp(p);
  const meta = await img.metadata();

  // DPR 会影响实际像素，裁剪用 OVERLAP * DPR
  const cropTop = idx === 0 ? 0 : Math.min(Math.floor(OVERLAP * DPR), (meta.height || 1) - 1);
  const cropHeight = (meta.height || 1) - cropTop;

  const buf = await img
    .extract({ left: 0, top: cropTop, width: meta.width, height: cropHeight })
    .toBuffer();

  images.push({ buf, width: meta.width, height: cropHeight });
}

const outWidth = images[0].width;
const outHeight = images.reduce((s, it) => s + it.height, 0);

let top = 0;
const composites = images.map((it) => {
  const c = { input: it.buf, top, left: 0 };
  top += it.height;
  return c;
});

await sharp({
  create: {
    width: outWidth,
    height: outHeight,
    channels: 4,
    background: { r: 255, g: 255, b: 255, alpha: 1 },
  },
})
  .composite(composites)
  .png()
  .toFile(outName);

console.log("已导出拼接长图：", outName);
console.log("分片目录：", tilesDir);
console.log("分片数量：", tilePaths.length);
