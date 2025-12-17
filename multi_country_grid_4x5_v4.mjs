import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const url = process.argv[2];
if (!url) {
  console.log('用法：node multi_country_grid_4x5_v4.mjs "<URL>" [输出目录]');
  process.exit(1);
}
const ROOT_OUT = (process.argv[3] || "grid_all_v3").trim();
if (!fs.existsSync(ROOT_OUT)) fs.mkdirSync(ROOT_OUT, { recursive: true });

// 默认所有国家；可用环境变量覆盖：$env:COUNTRIES="UK,DE,FR"
const ALL_CODES = ["US", "UK", "DE", "FR", "IT", "ES", "CA", "JP"];
const countries = (process.env.COUNTRIES || ALL_CODES.join(","))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const WIDTH = Number(process.env.WIDTH || 1440);
const BASE_HEIGHT = Number(process.env.HEIGHT || 3200);
const DPR = Number(process.env.DPR || 2);

const ITEM_SEL = ".product-item";
const ROWS_PER_SHOT = 5;

// 等待参数（慢就调大）
const WAIT_AFTER_GOTO_MS = Number(process.env.WAIT_AFTER_GOTO_MS || 5000);
const WAIT_AFTER_SCROLL_MS = Number(process.env.WAIT_AFTER_SCROLL_MS || 1600);
const WAIT_AFTER_SWITCH_MS = Number(process.env.WAIT_AFTER_SWITCH_MS || 2500);

const MAX_SCROLL_ROUNDS = Number(process.env.MAX_SCROLL_ROUNDS || 260);
const STABLE_ROUNDS_TO_STOP = Number(process.env.STABLE_ROUNDS_TO_STOP || 7);
const ENSURE_ROUNDS = Number(process.env.ENSURE_ROUNDS || 40);

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({
  viewport: { width: WIDTH, height: BASE_HEIGHT },
  deviceScaleFactor: DPR,
});
const page = await context.newPage();

await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
await page.waitForTimeout(WAIT_AFTER_GOTO_MS);

// ---------- 样式注入（带 marker，方便移除） ----------
async function addStyle(marker, css) {
  await page.addStyleTag({ content: `/*__${marker}__*/\n${css}` });
}
async function removeStyle(marker) {
  await page.evaluate((m) => {
    for (const s of Array.from(document.querySelectorAll("style"))) {
      if ((s.textContent || "").includes(`/*__${m}__*/`)) s.remove();
    }
  }, marker);
}

// 始终强制 4 列布局（不隐藏头尾，保证切国家按钮可点）
await addStyle(
  "GRID_STYLE",
  `
  .product-list{
    display: grid !important;
    grid-template-columns: repeat(4, 1fr) !important;
    gap: 14px !important;
    align-items: stretch !important;
  }
  .product-item{ width: 100% !important; }
`
);

// ---------- 截图时隐藏页头/页尾（只隐藏 fixed / sticky，避免误伤中文标题） ----------
async function applyHideHeaderFooter() {
  await page.evaluate(({ itemSel }) => {
    // 先清理旧标记
    for (const el of Array.from(document.querySelectorAll("[data-shot-hidden='1']"))) {
      el.style.visibility = "";
      el.style.display = "";
      el.removeAttribute("data-shot-hidden");
    }

    const productAny = document.querySelector(itemSel);
    const productRoot =
      productAny?.closest(".product-list") ||
      productAny?.parentElement ||
      null;

    function isVisible(el) {
      if (!el) return false;
      const st = getComputedStyle(el);
      if (st.display === "none" || st.visibility === "hidden" || st.opacity === "0") return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }

    function insideProduct(el) {
      if (!productRoot) return false;
      return productRoot.contains(el);
    }

    let hidden = 0;

    for (const el of Array.from(document.querySelectorAll("*"))) {
      if (!(el instanceof HTMLElement)) continue;
      if (!isVisible(el)) continue;

      const st = getComputedStyle(el);
      const pos = st.position;
      if (pos !== "fixed" && pos !== "sticky") continue;

      // 不隐藏商品区域内部的东西（避免误伤商品标题/中文行）
      if (insideProduct(el)) continue;

      const r = el.getBoundingClientRect();

      // 过滤很小的元素（避免误伤小图标）
      if (r.height < 40 || r.width < 200) continue;

      // 常见：顶部/底部导航条、浮层遮罩等
      el.setAttribute("data-shot-hidden", "1");
      el.style.visibility = "hidden";
      // 如果你遇到“仍然占位挡住商品”的情况，可以改成 display:none
      // el.style.display = "none";
      hidden += 1;
    }

    return hidden;
  }, { itemSel: ITEM_SEL });

  await page.waitForTimeout(400);
}

async function clearHideHeaderFooter() {
  await page.evaluate(() => {
    for (const el of Array.from(document.querySelectorAll("[data-shot-hidden='1']"))) {
      el.style.visibility = "";
      el.style.display = "";
      el.removeAttribute("data-shot-hidden");
    }
  });
  await page.waitForTimeout(200);
}

// ---------- 国家切换：打开 Location 弹窗并选择国家 ----------
async function isLocationVisible() {
  return await page
    .getByText("Location", { exact: true })
    .first()
    .isVisible()
    .catch(() => false);
}

async function openLocationModal() {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(500);

  // 优先：在左上角区域找“US/UK/DE...”并点击（比坐标更稳）
  const clicked = await page.evaluate((codes) => {
    function isVisible(el) {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
    }

    const candidates = [];
    for (const el of Array.from(document.querySelectorAll("*"))) {
      const t = (el.textContent || "").trim();
      if (!codes.includes(t)) continue;
      if (!isVisible(el)) continue;

      const r = el.getBoundingClientRect();
      if (r.left < 320 && r.top < 140 && r.right > 0 && r.bottom > 0) {
        candidates.push({ el, r });
      }
    }

    candidates.sort((a, b) => (a.r.top - b.r.top) || (a.r.left - b.r.left));
    if (candidates.length) {
      candidates[0].el.click();
      return true;
    }
    return false;
  }, ALL_CODES);

  if (!clicked) {
    // 兜底：左上角扫描点击，直到弹窗出现
    for (let y = 20; y <= 110; y += 15) {
      for (let x = 20; x <= 240; x += 20) {
        await page.mouse.click(x, y).catch(() => {});
        if (await isLocationVisible()) return;
        await page.waitForTimeout(120);
      }
    }
  }

  await page.waitForSelector("text=Location", { timeout: 20000 });
}

async function chooseCountryInModal(code) {
  await page.waitForSelector("text=Location", { timeout: 20000 });

  const ok = await page.evaluate((c) => {
    const heading = Array.from(document.querySelectorAll("*")).find(
      (el) => (el.textContent || "").trim() === "Location" && el.getBoundingClientRect().height > 0
    );
    if (!heading) return false;

    const container =
      heading.closest(".van-popup") ||
      heading.closest(".van-dialog") ||
      heading.closest("[role='dialog']") ||
      heading.parentElement;

    if (!container) return false;

    const els = Array.from(container.querySelectorAll("*"));
    const target = els.find((el) => (el.textContent || "").trim() === c && el.getBoundingClientRect().height > 0);
    if (target) {
      target.click();
      return true;
    }
    return false;
  }, code);

  if (!ok) {
    const popup = page.locator(".van-popup:visible, .van-dialog:visible, [role='dialog']:visible").first();
    const n = await popup.count().catch(() => 0);
    if (n > 0) {
      await popup.getByText(code, { exact: true }).first().click({ timeout: 8000 });
    } else {
      await page.getByText(code, { exact: true }).first().click({ timeout: 8000 });
    }
  }

  await page.waitForSelector("text=Location", { state: "hidden", timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(800);
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(WAIT_AFTER_SWITCH_MS);
}

async function switchCountry(code) {
  // 切换前保证页头不被隐藏（避免按钮点不到）
  await clearHideHeaderFooter();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(700);

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await openLocationModal();
      await chooseCountryInModal(code);
      await page.waitForSelector(ITEM_SEL, { timeout: 60000 });
      return;
    } catch (e) {
      if (attempt === 2) throw e;
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(800);
    }
  }
}

// ---------- 加载全量商品（尽量） ----------
async function loadAllItemsBestEffort() {
  await page.waitForSelector(ITEM_SEL, { timeout: 60000 });

  let stable = 0;
  let lastCount = -1;

  for (let r = 0; r < MAX_SCROLL_ROUNDS; r++) {
    const count = await page.locator(ITEM_SEL).count();
    stable = count === lastCount ? stable + 1 : 0;
    lastCount = count;

    if (stable >= STABLE_ROUNDS_TO_STOP) break;

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(WAIT_AFTER_SCROLL_MS);
    await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
  }

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(800);
}

async function ensureRendered(minCount) {
  for (let k = 0; k < ENSURE_ROUNDS; k++) {
    const c = await page.locator(ITEM_SEL).count();
    if (c >= minCount) return true;
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(WAIT_AFTER_SCROLL_MS);
  }
  return false;
}

// ---------- 计算截图区域：每张最多 5 行；最后不足 5 行也只出一张 ----------
async function computeRowSegmentBox(startIndex) {
  return await page.evaluate(({ sel, start, rowsWanted }) => {
    const items = Array.from(document.querySelectorAll(sel));
    if (start >= items.length) return null;

    const rects = [];
    for (let i = start; i < items.length; i++) {
      const r = items[i].getBoundingClientRect();
      rects.push({ i, top: r.top, left: r.left, right: r.right, bottom: r.bottom });
    }

    const tol = 6;
    const rows = [];
    for (const it of rects) {
      let row = rows.find((x) => Math.abs(x.top - it.top) <= tol);
      if (!row) {
        row = { top: it.top, items: [] };
        rows.push(row);
      }
      row.items.push(it);
    }
    rows.sort((a, b) => a.top - b.top);

    const takeRows = Math.min(rowsWanted, rows.length);
    const usedRows = rows.slice(0, takeRows);

    let left = Infinity,
      top = Infinity,
      right = -Infinity,
      bottom = -Infinity;
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
      nextStart: lastIndex + 1,
      takeRows,
    };
  }, { sel: ITEM_SEL, start: startIndex, rowsWanted: ROWS_PER_SHOT });
}

async function scrollSegmentToTop(seg) {
  await page.evaluate((yy) => {
    const target = window.scrollY + yy - 8;
    window.scrollTo(0, Math.max(0, target));
  }, seg.y);
  await page.waitForTimeout(650);
}

async function captureCountry(code) {
  const outDir = path.join(ROOT_OUT, code);
  ensureDir(outDir);

  // 截图前：只隐藏 fixed/sticky 的页头页尾（不会删中文）
  await applyHideHeaderFooter();

  // 尽量加载全量
  await loadAllItemsBestEffort();
  let total = await page.locator(ITEM_SEL).count();
  console.log(`[${code}] 商品数量: ${total}`);
  if (!total) {
    await clearHideHeaderFooter();
    return;
  }

  let start = 0;
  let shotNo = 1;

  while (start < total) {
    await ensureRendered(start + 1);

    await page.locator(ITEM_SEL).nth(start).scrollIntoViewIfNeeded();
    await page.waitForTimeout(700);

    let seg = await computeRowSegmentBox(start);
    if (!seg) break;

    await scrollSegmentToTop(seg);

    seg = await computeRowSegmentBox(start);
    if (!seg) break;

    // 保证 clip 完全落在视口内（解决第 5 行截断）
    const vp = page.viewportSize();
    if (seg.y + seg.h > vp.height - 6) {
      const needH = Math.min(9000, Math.ceil(seg.y + seg.h + 60));
      await page.setViewportSize({ width: WIDTH, height: needH });
      await page.waitForTimeout(300);

      seg = await computeRowSegmentBox(start);
      await scrollSegmentToTop(seg);
      seg = await computeRowSegmentBox(start);
    }

    const outPath = path.join(outDir, `page_${String(shotNo).padStart(3, "0")}.png`);
    await page.screenshot({
      path: outPath,
      clip: {
        x: Math.max(0, Math.floor(seg.x)),
        y: Math.max(0, Math.floor(seg.y)),
        width: Math.max(1, Math.floor(seg.w)),
        height: Math.max(1, Math.floor(seg.h)),
      },
    });

    console.log(`[${code}] 输出: ${outPath}（行=${seg.takeRows}, start=${start} -> next=${seg.nextStart}）`);

    start = seg.nextStart; // 最后不足 5 行也一次截完
    shotNo += 1;

    await page.setViewportSize({ width: WIDTH, height: BASE_HEIGHT });
    await page.waitForTimeout(120);

    total = await page.locator(ITEM_SEL).count();
  }

  // 恢复（给下一国家切换使用）
  await clearHideHeaderFooter();
  await page.setViewportSize({ width: WIDTH, height: BASE_HEIGHT });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(500);
}

// ---------- 主流程：逐国家切换 + 截图 ----------
for (const code of countries) {
  console.log(`\n=== 切换国家：${code} ===`);
  await switchCountry(code);
  await captureCountry(code);
}

await browser.close();
console.log("\n全部完成。输出目录：", ROOT_OUT);
