import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const url = process.argv[2];
if (!url) {
  console.log('用法：node multi_country_grid_4x5_v4.mjs "<URL>" [输出目录]');
  process.exit(1);
}

const ROOT_OUT = (process.argv[3] || "grid_all").trim();
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

// 新增：关键超时/重试（Actions 更稳）
const ITEM_VISIBLE_TIMEOUT_MS = Number(process.env.ITEM_VISIBLE_TIMEOUT_MS || 120000); // 等商品出现
const SWITCH_RETRIES = Number(process.env.SWITCH_RETRIES || 3); // 切国家重试次数

const MAX_SCROLL_ROUNDS = Number(process.env.MAX_SCROLL_ROUNDS || 260);
const STABLE_ROUNDS_TO_STOP = Number(process.env.STABLE_ROUNDS_TO_STOP || 7);
const ENSURE_ROUNDS = Number(process.env.ENSURE_ROUNDS || 40);

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

async function safeShot(filePath) {
  try {
    ensureDir(path.dirname(filePath));
    await page.screenshot({ path: filePath, fullPage: true });
  } catch {}
}

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  // 一些环境下能稍微提升稳定性（可选）
  args: ["--disable-dev-shm-usage"],
});

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
    const productRoot = productAny?.closest(".product-list") || productAny?.parentElement || null;

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

    for (const el of Array.from(document.querySelectorAll("*"))) {
      if (!(el instanceof HTMLElement)) continue;
      if (!isVisible(el)) continue;

      const st = getComputedStyle(el);
      const pos = st.position;
      if (pos !== "fixed" && pos !== "sticky") continue;

      // 不隐藏商品区域内部的东西（避免误伤商品标题/中文行）
      if (insideProduct(el)) continue;

      const r = el.getBoundingClientRect();
      if (r.height < 40 || r.width < 200) continue;

      el.setAttribute("data-shot-hidden", "1");
      el.style.visibility = "hidden";
      // 如遇到“仍然占位挡住商品”，可改成 display:none
      // el.style.display = "none";
    }
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
  return await page.getByText("Location", { exact: true }).first().isVisible().catch(() => false);
}

async function openLocationModal() {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(500);

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
    for (let y = 20; y <= 110; y += 15) {
      for (let x = 20; x <= 240; x += 20) {
        // eslint-disable-next-line no-await-in-loop
        await page.mouse.click(x, y).catch(() => {});
        // eslint-disable-next-line no-await-in-loop
        if (await isLocationVisible()) return;
        // eslint-disable-next-line no-await-in-loop
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

// 等商品出现；如果明显为空态，则返回 empty=true
async function waitItemsOrEmpty() {
  const first = page.locator(ITEM_SEL).first();

  try {
    await first.waitFor({ state: "visible", timeout: ITEM_VISIBLE_TIMEOUT_MS });
    return { ok: true, empty: false };
  } catch {
    // 典型空态（尽量宽松匹配）
    const empty =
      (await page.locator(".van-empty, .empty, [class*='empty']").first().isVisible().catch(() => false)) || false;

    const count = await page.locator(ITEM_SEL).count().catch(() => 0);
    if (empty || count === 0) return { ok: true, empty: true };

    return { ok: false, empty: false };
  }
}

async function switchCountry(code) {
  // 切换前保证页头不被隐藏（避免按钮点不到）
  await clearHideHeaderFooter();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(700);

  for (let attempt = 1; attempt <= SWITCH_RETRIES; attempt++) {
    try {
      await openLocationModal();
      await chooseCountryInModal(code);

      const st = await waitItemsOrEmpty();
      if (st.ok) {
        if (st.empty) console.log(`[${code}] 提示：该国家可能暂无商品（将跳过截图）`);
        return st; // {ok:true, empty:...}
      }

      throw new Error(`[${code}] 切换后仍未出现商品卡片（可能接口慢/异常）`);
    } catch (e) {
      if (attempt === SWITCH_RETRIES) throw e;

      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(800);
      await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
      await page.waitForTimeout(1200);
    }
  }

  return { ok: false, empty: false };
}

// ---------- 加载全量商品（尽量） ----------
async function loadAllItemsBestEffort() {
  // 用更长的超时，避免慢国家偶发失败
  await page.waitForSelector(ITEM_SEL, { timeout: ITEM_VISIBLE_TIMEOUT_MS });

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

// ---------- 主流程：逐国家切换 + 截图（单国家失败不影响整体） ----------
for (const code of countries) {
  console.log(`\n=== 切换国家：${code} ===`);

  try {
    const st = await switchCountry(code);

    // 空态直接跳过（不截图）
    const cnt = await page.locator(ITEM_SEL).count().catch(() => 0);
    if (st?.empty || cnt === 0) {
      console.log(`[${code}] 0 商品或空态，跳过。`);
      continue;
    }

    await captureCountry(code);
  } catch (e) {
    console.log(`[${code}] 失败：`, e?.message || e);

    // 留一张失败现场图，便于排查
    await safeShot(path.join(ROOT_OUT, "_errors", `${code}_switch.png`));

    // 继续下一个国家，不让脚本退出 1
    continue;
  }
}

await browser.close();
console.log("\n全部完成。输出目录：", ROOT_OUT);
