// Alfaview — Portable self-contained build
// Run: npm install && npm start
// Configure via .env (see .env.example)

const express = require('express');
const https = require('https');
const fs = require('fs');
const path = require('path');

require('dotenv').config();

const PORT = Number(process.env.PORT) || 5000;
// Accept both names — TELEGRAM_TOKEN (default) and BOT_TOKEN (Render-style)
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

// DATA_DIR — point this at a Render Persistent Disk mount (e.g. /var/data)
// to keep positions + history across deploys/restarts. Defaults to ./data.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // Render is behind a load balancer
app.use(express.json({ limit: '256kb' }));

const STATE_FILE = path.join(DATA_DIR, 'positions.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (e) {
  console.error(`[fatal] cannot create DATA_DIR=${DATA_DIR}: ${e.message}`);
  process.exit(1);
}

function sendTelegramMessage(text) {
  if (!TELEGRAM_TOKEN || !CHAT_ID) {
    return Promise.resolve({ ok: false, skipped: true, reason: 'No TELEGRAM_TOKEN/CHAT_ID configured' });
  }
  const body = JSON.stringify({ chat_id: CHAT_ID, text });
  const options = {
    hostname: 'api.telegram.org',
    path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  };
  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch { parsed = { ok: false, raw: data }; }
        if (!parsed.ok) {
          console.error(`[telegram] FAILED status=${res.statusCode} code=${parsed.error_code || '?'} desc="${parsed.description || parsed.raw || 'unknown'}"`);
        }
        lastTelegramResult = { ok: parsed.ok, statusCode: res.statusCode, error_code: parsed.error_code, description: parsed.description, at: new Date().toISOString() };
        resolve(parsed);
      });
    });
    req.on('error', (e) => {
      console.error(`[telegram] network error: ${e.message}`);
      lastTelegramResult = { ok: false, networkError: e.message, at: new Date().toISOString() };
      resolve({ ok: false, error: e.message });
    });
    req.write(body);
    req.end();
  });
}
let lastTelegramResult = null;

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function fetchBars(interval, range) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/GC=F?range=${range}&interval=${interval}`;
  const json = await httpsGetJson(url);
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error('No chart data');
  const ts = result.timestamp || [];
  const q = result.indicators.quote[0];
  const candles = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.close[i] == null) continue;
    candles.push({ t: ts[i], open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i] });
  }
  return { candles, meta: result.meta };
}
async function fetchXauHistory() {
  const r = await fetchBars('1d', '3mo');
  if (r.candles.length < 50) throw new Error('Insufficient history');
  return r;
}
async function fetchXauMultiTF() {
  const [daily, hourly] = await Promise.all([fetchBars('1d', '3mo'), fetchBars('1h', '1mo')]);
  if (daily.candles.length < 50) throw new Error('Insufficient daily history');
  if (hourly.candles.length < 60) throw new Error('Insufficient hourly history');
  return { daily, hourly };
}

// ---------- Indicators ----------
function ema(values, period) {
  const k = 2 / (period + 1);
  const out = [];
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) { out.push(null); continue; }
    if (i === period - 1) { out.push(prev); continue; }
    prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}
function rsi(values, period = 14) {
  const out = new Array(values.length).fill(null);
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgG = gain / period, avgL = loss / period;
  out[period] = 100 - 100 / (1 + (avgL === 0 ? 100 : avgG / avgL));
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    const g = d > 0 ? d : 0; const l = d < 0 ? -d : 0;
    avgG = (avgG * (period - 1) + g) / period;
    avgL = (avgL * (period - 1) + l) / period;
    out[i] = 100 - 100 / (1 + (avgL === 0 ? 100 : avgG / avgL));
  }
  return out;
}
function macd(values, fast = 12, slow = 26, signal = 9) {
  const ef = ema(values, fast), es = ema(values, slow);
  const line = values.map((_, i) => ef[i] != null && es[i] != null ? ef[i] - es[i] : null);
  const pts = line.filter((v) => v != null);
  const sigSeries = ema(pts, signal);
  const offset = line.length - pts.length;
  const sigLine = line.map((_, i) => i - offset >= 0 ? sigSeries[i - offset] : null);
  const hist = line.map((v, i) => v != null && sigLine[i] != null ? v - sigLine[i] : null);
  return { line, signal: sigLine, hist };
}
function atr(candles, period = 14) {
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  const out = [null];
  let a = trs.slice(0, period).reduce((x, y) => x + y, 0) / period;
  for (let i = 0; i < trs.length; i++) {
    if (i < period - 1) { out.push(null); continue; }
    if (i === period - 1) { out.push(a); continue; }
    a = (a * (period - 1) + trs[i]) / period;
    out.push(a);
  }
  return out;
}
function adx(candles, period = 14) {
  const n = candles.length;
  if (n < period * 2 + 1) return { adx: null, plusDI: null, minusDI: null };
  let smTR = 0, smPlusDM = 0, smMinusDM = 0;
  for (let i = 1; i <= period; i++) {
    const c = candles[i], p = candles[i - 1];
    const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    const up = c.high - p.high, dn = p.low - c.low;
    smTR += tr;
    smPlusDM += up > dn && up > 0 ? up : 0;
    smMinusDM += dn > up && dn > 0 ? dn : 0;
  }
  const dxArr = [];
  let lastPlusDI = 0, lastMinusDI = 0;
  for (let i = period + 1; i < n; i++) {
    const c = candles[i], p = candles[i - 1];
    const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    const up = c.high - p.high, dn = p.low - c.low;
    const pDM = up > dn && up > 0 ? up : 0;
    const mDM = dn > up && dn > 0 ? dn : 0;
    smTR = smTR - smTR / period + tr;
    smPlusDM = smPlusDM - smPlusDM / period + pDM;
    smMinusDM = smMinusDM - smMinusDM / period + mDM;
    const pDI = (smPlusDM / smTR) * 100;
    const mDI = (smMinusDM / smTR) * 100;
    lastPlusDI = pDI; lastMinusDI = mDI;
    dxArr.push((Math.abs(pDI - mDI) / Math.max(0.0001, pDI + mDI)) * 100);
  }
  if (dxArr.length < period) return { adx: null, plusDI: lastPlusDI, minusDI: lastMinusDI };
  let v = dxArr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dxArr.length; i++) v = (v * (period - 1) + dxArr[i]) / period;
  return { adx: v, plusDI: lastPlusDI, minusDI: lastMinusDI };
}
function swingLevels(candles, lookback = 20) {
  const n = candles.length, start = Math.max(0, n - 1 - lookback);
  let hi = -Infinity, lo = Infinity;
  for (let i = start; i < n - 1; i++) {
    if (candles[i].high > hi) hi = candles[i].high;
    if (candles[i].low < lo) lo = candles[i].low;
  }
  return { swingHigh: hi, swingLow: lo };
}
function analyzeMarketHQ(daily, hourly, opts = {}) {
  const dC = daily.map((c) => c.close);
  const dE20 = ema(dC, 20), dE50 = ema(dC, 50);
  const dAdx = adx(daily, 14);
  const di = dC.length - 1, dPrice = dC[di];
  const htfUp = dE20[di] > dE50[di] && dPrice > dE50[di];
  const htfDown = dE20[di] < dE50[di] && dPrice < dE50[di];
  const htfBias = htfUp ? 'BUY' : htfDown ? 'SELL' : 'NEUTRAL';

  const hC = hourly.map((c) => c.close);
  const hE20 = ema(hC, 20), hE50 = ema(hC, 50);
  const hRsi = rsi(hC, 14);
  const hMacd = macd(hC);
  const hAtr = atr(hourly, 14);
  const hAdx = adx(hourly, 14);
  const hi = hC.length - 1;
  const price = hC[hi], e20 = hE20[hi], e50 = hE50[hi], r = hRsi[hi];
  const mLine = hMacd.line[hi], mSig = hMacd.signal[hi];
  const mHist = hMacd.hist[hi], mHistPrev = hMacd.hist[hi - 1];
  const a = hAtr[hi], hAdxVal = hAdx.adx ?? 0, dAdxVal = dAdx.adx ?? 0;

  const ltfUp = e20 > e50 && price > e20 && mLine > mSig;
  const ltfDown = e20 < e50 && price < e20 && mLine < mSig;
  const ltfBias = ltfUp ? 'BUY' : ltfDown ? 'SELL' : 'NEUTRAL';

  // Direction selection — caller may force a direction (used by hunt mode to
  // evaluate the opposite side as a counter-trend candidate). Otherwise the
  // engine picks based on HTF/LTF alignment with hard-block on direct conflict.
  const reasons = [];
  let score = 0;
  let direction = null;
  let counterTrend = false;
  if (opts.forceDirection === 'BUY' || opts.forceDirection === 'SELL') {
    direction = opts.forceDirection;
    counterTrend = (htfBias !== 'NEUTRAL' && htfBias !== direction);
    if (counterTrend) {
      score += 5; reasons.push(`⚠️ Counter-trend ${direction} (HTF=${htfBias}) — hunt mode`);
    } else if (htfBias === direction && ltfBias === direction) {
      score += 30; reasons.push(`✅ Multi-TF aligned (1D + 1H = ${direction})`);
    } else if (htfBias === direction) {
      score += 15; reasons.push(`⚠️ HTF=${direction}, LTF mixed — riding higher timeframe`);
    } else if (ltfBias === direction) {
      score += 10; reasons.push(`⚠️ HTF neutral, LTF=${direction} — short-term setup only`);
    } else {
      score += 5; reasons.push(`⚠️ Forced ${direction} (both TFs neutral)`);
    }
  } else if (htfBias !== 'NEUTRAL' && ltfBias !== 'NEUTRAL' && htfBias !== ltfBias) {
    reasons.push(`❌ HTF/LTF conflict (HTF=${htfBias} vs LTF=${ltfBias}) — no trade`);
    return { direction: htfBias, confidence: 0, reasons,
      atr: a, indicators: { ema20: e20, ema50: e50, rsi: r, macdLine: mLine, macdSignal: mSig, macdHist: mHist, adx: hAdxVal, htfBias, ltfBias }, entry: price, sl: 0, tp: 0, riskLabel: '—' };
  } else if (htfBias !== 'NEUTRAL' && htfBias === ltfBias) {
    direction = htfBias;
    score += 30; reasons.push(`✅ Multi-TF aligned (1D + 1H = ${direction})`);
  } else if (htfBias !== 'NEUTRAL') {
    direction = htfBias;
    score += 15; reasons.push(`⚠️ HTF=${htfBias}, LTF neutral — riding higher timeframe`);
  } else if (ltfBias !== 'NEUTRAL') {
    direction = ltfBias;
    score += 10; reasons.push(`⚠️ HTF neutral, LTF=${ltfBias} — short-term setup only`);
  } else {
    reasons.push('⚠️ Both timeframes neutral — no clear direction');
    return { direction: 'BUY', confidence: 0, reasons,
      atr: a, indicators: { ema20: e20, ema50: e50, rsi: r, macdLine: mLine, macdSignal: mSig, macdHist: mHist, adx: hAdxVal, htfBias, ltfBias }, entry: price, sl: 0, tp: 0, riskLabel: '—' };
  }
  if (hAdxVal >= 30) { score += 20; reasons.push(`✅ Strong trend (ADX ${hAdxVal.toFixed(1)})`); }
  else if (hAdxVal >= 22) { score += 12; reasons.push(`✅ Moderate trend (ADX ${hAdxVal.toFixed(1)})`); }
  else reasons.push(`⚠️ Weak trend (ADX ${hAdxVal.toFixed(1)})`);
  const rsiHealthy = direction === 'BUY' ? r > 50 && r < 68 : r < 50 && r > 32;
  const rsiExtreme = direction === 'BUY' ? r >= 75 : r <= 25;
  if (rsiHealthy) { score += 15; reasons.push(`✅ RSI healthy (${r.toFixed(1)})`); }
  else if (rsiExtreme) reasons.push(`⚠️ RSI exhausted (${r.toFixed(1)})`);
  else { score += 5; reasons.push(`⚠️ RSI neutral (${r.toFixed(1)})`); }
  const momOk = direction === 'BUY' ? mHist > mHistPrev && mHist > 0 : mHist < mHistPrev && mHist < 0;
  if (momOk) { score += 10; reasons.push('✅ MACD momentum confirms'); }
  else reasons.push('⚠️ MACD momentum weak');
  const distAtr = Math.abs(price - e20) / a;
  if (distAtr <= 0.8) { score += 15; reasons.push(`✅ Pullback entry (${distAtr.toFixed(2)}× ATR from EMA20)`); }
  else if (distAtr <= 1.5) { score += 7; reasons.push(`⚠️ Slightly extended (${distAtr.toFixed(2)}× ATR)`); }
  else reasons.push(`❌ Chasing — price ${distAtr.toFixed(2)}× ATR from EMA20`);
  if (dAdxVal >= 22) { score += 10; reasons.push(`✅ Daily trend confirmed (ADX ${dAdxVal.toFixed(1)})`); }
  else reasons.push(`⚠️ Daily trend soft (ADX ${dAdxVal.toFixed(1)})`);
  // Counter-trend setups are capped at 65% so they can never out-rank a clean
  // trend-following setup of the same raw quality.
  const confidence = Math.min(counterTrend ? 65 : 100, score);
  const { swingHigh, swingLow } = swingLevels(hourly, 20);
  const buffer = a * 0.5;
  let sl, tp;
  if (direction === 'BUY') {
    sl = Math.min(swingLow - buffer, price - a * 1.2);
    tp = price + (price - sl) * 2;
  } else {
    sl = Math.max(swingHigh + buffer, price + a * 1.2);
    tp = price - (sl - price) * 2;
  }
  const riskLabel = confidence >= 85 ? 'Low' : confidence >= 75 ? 'Medium' : 'High';
  return { direction, confidence, entry: price, sl, tp, atr: a, counterTrend,
    indicators: { ema20: e20, ema50: e50, rsi: r, macdLine: mLine, macdSignal: mSig, macdHist: mHist, adx: hAdxVal, dailyAdx: dAdxVal, htfBias, ltfBias, swingHigh, swingLow },
    reasons, riskLabel };
}

function analyzeMarket(candles) {
  const closes = candles.map((c) => c.close);
  const ema20 = ema(closes, 20), ema50 = ema(closes, 50);
  const rsiSeries = rsi(closes, 14);
  const m = macd(closes);
  const atrSeries = atr(candles, 14);
  const i = closes.length - 1;
  const price = closes[i], e20 = ema20[i], e50 = ema50[i], r = rsiSeries[i];
  const mLine = m.line[i], mSig = m.signal[i], mHist = m.hist[i], mHistPrev = m.hist[i - 1];
  const a = atrSeries[i];
  const reasons = []; let bull = 0, bear = 0;
  if (e20 > e50) { bull += 30; reasons.push('Uptrend (EMA20>EMA50)'); } else { bear += 30; reasons.push('Downtrend'); }
  if (price > e20) { bull += 15; reasons.push('Price above EMA20'); } else { bear += 15; reasons.push('Price below EMA20'); }
  if (r > 50 && r < 70) { bull += 25; reasons.push(`RSI bullish ${r.toFixed(1)}`); }
  else if (r < 50 && r > 30) { bear += 25; reasons.push(`RSI bearish ${r.toFixed(1)}`); }
  else if (r >= 70) { bear += 10; reasons.push(`RSI overbought ${r.toFixed(1)}`); }
  else { bull += 10; reasons.push(`RSI oversold ${r.toFixed(1)}`); }
  if (mLine > mSig) { bull += 20; reasons.push('MACD above signal'); } else { bear += 20; reasons.push('MACD below signal'); }
  if (mHist > mHistPrev && mHist > 0) { bull += 10; reasons.push('MACD momentum rising'); }
  else if (mHist < mHistPrev && mHist < 0) { bear += 10; reasons.push('MACD momentum falling'); }
  const direction = bull > bear ? 'BUY' : 'SELL';
  const confidence = Math.max(bull, bear);
  const slDist = a * 1.5;
  const sl = direction === 'BUY' ? price - slDist : price + slDist;
  const tp = direction === 'BUY' ? price + slDist * 2 : price - slDist * 2;
  const riskLabel = confidence >= 80 ? 'Low' : confidence >= 65 ? 'Medium' : 'High';
  return {
    direction, confidence, entry: price, sl, tp, atr: a,
    indicators: { ema20: e20, ema50: e50, rsi: r, macdLine: mLine, macdSignal: mSig, macdHist: mHist },
    reasons, riskLabel,
  };
}

// Live spot XAU/USD price source — gold-api.com (free, no key, matches OANDA/TradingView spot).
// Cached 5s to avoid hammering the upstream while still feeling realtime in the UI.
let _spotCache = { at: 0, price: null };
function fetchSpotXau() {
  return new Promise((resolve, reject) => {
    if (_spotCache.price && Date.now() - _spotCache.at < 5000) return resolve(_spotCache.price);
    https.get('https://api.gold-api.com/price/XAU', { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 }, (res) => {
      let data = ''; res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          const p = Number(j.price);
          if (!isFinite(p) || p <= 0) return reject(new Error('Invalid spot price'));
          _spotCache = { at: Date.now(), price: p };
          resolve(p);
        } catch (e) { reject(e); }
      });
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('spot timeout')); });
  });
}

// Returns OHLC-like envelope using spot price for "close" and the Yahoo daily
// high/low for day-range context. The date/time fields use the spot timestamp.
async function fetchXauUsd() {
  const spot = await fetchSpotXau();
  let dayHigh = spot, dayLow = spot, dayOpen = spot;
  try {
    const r = await fetchBars('1d', '5d');
    const last = r.candles[r.candles.length - 1];
    if (last) { dayHigh = last.high; dayLow = last.low; dayOpen = last.open; }
  } catch (_) { /* fall back to spot-only if Yahoo blips */ }
  const now = new Date();
  return { date: now.toISOString().slice(0, 10), time: now.toISOString().slice(11, 19),
           open: dayOpen, high: Math.max(dayHigh, spot), low: Math.min(dayLow, spot), close: spot };
}

const fmt = (n) => Number(n).toFixed(2);

const openPositions = new Map();
let positionCounter = 0;
let history = [];

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) || {};
      const apply = (k, min, max) => {
        if (saved[k] != null && Number.isFinite(+saved[k])) {
          settings[k] = Math.max(min, Math.min(max, +saved[k]));
        }
      };
      const applyBool = (k) => { if (typeof saved[k] === 'boolean') settings[k] = saved[k]; };
      apply('minConfidence', 0, 100);
      apply('rrRatio', 0.1, 10);
      apply('slMultiplier', 0.1, 10);
      apply('cooldownSec', 0, 86400);
      apply('maxOpenPositions', 1, 10);
      apply('huntFloorConfidence', 40, 95);
      apply('huntStepPct', 1, 20);
      apply('huntStepSec', 15, 3600);
      apply('maxConsecutiveLosses', 0, 20);
      apply('dailyLossLimit', 0, 1e9);
      apply('autoConfidenceWindow', 5, 100);
      apply('autoConfidencePercentile', 50, 95);
      apply('idleFallbackAfterSec', 60, 7200);
      apply('idleFallbackMinConfidence', 20, 80);
      applyBool('huntModeEnabled');
      applyBool('breakevenEnabled');
      applyBool('trailingStopEnabled');
      applyBool('dailySummaryEnabled');
      applyBool('autoConfidenceEnabled');
      applyBool('idleFallbackEnabled');
      console.log(`[settings] loaded saved values from ${SETTINGS_FILE}`);
    }
  } catch (e) { console.error('[settings] load failed:', e.message); }
}
function saveSettings() {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
    return true;
  } catch (e) { console.error('[settings] save failed:', e.message); return false; }
}
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      positionCounter = raw.counter || 0;
      for (const [id, pos] of raw.positions || []) openPositions.set(Number(id), pos);
    }
    if (fs.existsSync(HISTORY_FILE)) history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')) || [];
  } catch (e) { console.error('[state] load failed:', e.message); }
}
function saveState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify({ counter: positionCounter, positions: [...openPositions.entries()] }, null, 2)); }
  catch (e) { console.error('[state] save failed:', e.message); }
}
function saveHistory() {
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2)); }
  catch (e) { console.error('[history] save failed:', e.message); }
}
function recordClosed(pos, exitPrice, result) {
  const moveAbs = Math.abs(exitPrice - pos.entry);
  const profit = pos.direction === 'BUY' ? exitPrice - pos.entry : pos.entry - exitPrice;
  history.unshift({
    id: pos.id, pair: pos.pair, direction: pos.direction,
    entry: pos.entry, exit: exitPrice, sl: pos.sl, tp: pos.tp,
    result, profit, profitPct: (profit / pos.entry) * 100,
    openedAt: pos.openedAt, closedAt: new Date().toISOString(),
  });
  if (history.length > 200) history.length = 200;
  saveHistory();
  return moveAbs;
}
function computeStats() {
  const trades = history.length;
  const wins = history.filter((h) => h.profit > 0).length;
  const losses = history.filter((h) => h.profit < 0).length;
  const winRate = trades ? (wins / trades) * 100 : 0;
  const totalPL = history.reduce((s, h) => s + h.profit, 0);
  const avgPL = trades ? totalPL / trades : 0;
  const bestTrade = history.reduce((m, h) => (h.profit > (m?.profit ?? -Infinity) ? h : m), null);
  const worstTrade = history.reduce((m, h) => (h.profit < (m?.profit ?? Infinity) ? h : m), null);
  return { trades, wins, losses, winRate, totalPL, avgPL, bestTrade, worstTrade };
}
loadState();

async function checkOpenPositions() {
  if (openPositions.size === 0) return;
  let price;
  try { price = await fetchSpotXau(); } catch (e) { return console.error('[tracker]', e.message); }
  for (const [id, pos] of openPositions) {
    if (pos.pair !== 'XAU/USD') continue;

    // ---- Auto breakeven + trailing stop -----------------------------------
    // Once trade is +1× ATR in profit -> move SL to entry (risk-free trade).
    // Once trade is +2× ATR in profit -> trail SL 1× ATR behind current price.
    const atrUnit = pos.atr || Math.abs(pos.entry - pos.sl) * 0.6 || 5;
    const profitAbs = pos.direction === 'BUY' ? price - pos.entry : pos.entry - price;
    if (settings.breakevenEnabled && !pos.breakevenMoved && profitAbs >= atrUnit) {
      const oldSL = pos.sl; pos.sl = pos.entry; pos.breakevenMoved = true; saveState();
      sendTelegramMessage(`🛡️ BREAKEVEN #${id}\n\nPair: ${pos.pair} ${pos.direction}\nSL moved: ${fmt(oldSL)} → ${fmt(pos.sl)}\nTrade is now risk-free.`).catch(() => {});
      console.log(`[tracker] breakeven moved on #${id}`);
    }
    if (settings.trailingStopEnabled && profitAbs >= atrUnit * 2) {
      const newSL = pos.direction === 'BUY' ? price - atrUnit : price + atrUnit;
      const better = pos.direction === 'BUY' ? newSL > pos.sl : newSL < pos.sl;
      if (better) { pos.sl = newSL; saveState(); }
    }

    // ---- TP / SL check ----------------------------------------------------
    let hit = null;
    if (pos.direction === 'BUY') {
      if (price >= pos.tp) hit = 'TP'; else if (price <= pos.sl) hit = 'SL';
    } else {
      if (price <= pos.tp) hit = 'TP'; else if (price >= pos.sl) hit = 'SL';
    }
    if (!hit) continue;
    openPositions.delete(id); saveState();
    recordClosed({ ...pos, id }, price, hit);
    const moveAbs = Math.abs(price - pos.entry);
    const pct = ((moveAbs / pos.entry) * 100).toFixed(2);
    const profit = pos.direction === 'BUY' ? price - pos.entry : pos.entry - price;
    const win = profit >= 0;
    const beTag = pos.breakevenMoved && hit === 'SL' ? ' (breakeven exit)' : '';
    const msg = win
      ? `📊 RESULT\n\nPair: ${pos.pair}\nResult: ${hit} HIT ✅\n\nEntry: ${fmt(pos.entry)} → Exit: ${fmt(price)}\nProfit: +${fmt(moveAbs)} (${pct}%)`
      : `📊 RESULT\n\nPair: ${pos.pair}\nResult: SL HIT ❌${beTag}\n\nEntry: ${fmt(pos.entry)} → Exit: ${fmt(price)}\n${pos.breakevenMoved ? 'P/L: 0 (closed at breakeven)' : 'Loss: -' + fmt(moveAbs) + ' (' + pct + '%)'}`;
    sendTelegramMessage(msg).catch((e) => console.error('[tracker] tg:', e.message));
    console.log(`[tracker] ${hit} hit on #${id} @ ${price}`);

    // ---- Circuit breaker --------------------------------------------------
    checkCircuitBreaker(profit);
  }
}
setInterval(checkOpenPositions, 20_000);

// ---- Circuit breaker: pause auto-mode after N consecutive losses or daily $ loss
let consecLosses = 0;
function checkCircuitBreaker(profit) {
  if (profit < 0) consecLosses++; else consecLosses = 0;
  const todayLoss = todaysPL();
  let trip = null;
  if (settings.maxConsecutiveLosses > 0 && consecLosses >= settings.maxConsecutiveLosses) {
    trip = `${consecLosses} losses in a row`;
  } else if (settings.dailyLossLimit > 0 && todayLoss <= -settings.dailyLossLimit) {
    trip = `daily loss reached -$${fmt(Math.abs(todayLoss))}`;
  }
  if (trip && autoEnabled) {
    autoEnabled = false;
    sendTelegramMessage(`🚨 AUTO-MODE PAUSED\n\nReason: ${trip}\n\nAuto-trading stopped to protect capital.\nResume manually from the dashboard when ready.`).catch(() => {});
    console.log(`[circuit-breaker] auto paused: ${trip}`);
  }
}
function todaysPL() {
  const today = new Date().toISOString().slice(0, 10);
  return history.filter((h) => h.closedAt?.startsWith(today)).reduce((s, h) => s + h.profit, 0);
}

// ---- Daily summary (once per UTC day) ---------------------------------
let _lastSummaryDay = null;
function maybeDailySummary() {
  if (!settings.dailySummaryEnabled) return;
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  if (_lastSummaryDay === day) return;
  if (now.getUTCHours() !== 0) return; // fire in the 00:00–00:59 UTC window
  _lastSummaryDay = day;
  const yest = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);
  const trades = history.filter((h) => h.closedAt?.startsWith(yest));
  if (trades.length === 0) return;
  const wins = trades.filter((t) => t.profit > 0).length;
  const losses = trades.filter((t) => t.profit < 0).length;
  const totalPL = trades.reduce((s, t) => s + t.profit, 0);
  const wr = ((wins / trades.length) * 100).toFixed(0);
  const sign = totalPL >= 0 ? '+' : '';
  const best = trades.reduce((m, t) => (t.profit > (m?.profit ?? -Infinity) ? t : m), null);
  sendTelegramMessage(
    `📈 DAILY SUMMARY — ${yest}\n\n` +
    `Trades: ${trades.length}\n` +
    `Wins / Losses: ${wins} / ${losses}\n` +
    `Win rate: ${wr}%\n` +
    `Net P/L: ${sign}${fmt(totalPL)} pts\n` +
    (best ? `Best: ${best.direction} +${fmt(best.profit)}\n` : '')
  ).catch(() => {});
}
setInterval(maybeDailySummary, 5 * 60_000);

// Auto-signal scan interval. Default 60s — patient quality-first scanning.
const AUTO_INTERVAL = Math.max(5, Number(process.env.AUTO_INTERVAL_SEC) || 60) * 1000;
const settings = {
  // Quality-first defaults: only fire on A-grade setups, one position at a time.
  minConfidence: Math.max(40, Math.min(100, Number(process.env.MIN_CONFIDENCE) || 75)),
  rrRatio: Math.max(0.5, Math.min(10, Number(process.env.RR_RATIO) || 2)),
  slMultiplier: Math.max(0.5, Math.min(5, Number(process.env.SL_MULTIPLIER) || 1.5)),
  cooldownSec: Math.max(0, Math.min(86400, Number(process.env.COOLDOWN_SEC) || 0)),
  maxOpenPositions: Math.max(1, Math.min(10, Number(process.env.MAX_OPEN_POSITIONS) || 1)),
  // Hunt mode OFF by default — was firing too many marginal trades.
  huntModeEnabled: process.env.HUNT_MODE === '1',
  huntFloorConfidence: Math.max(40, Math.min(95, Number(process.env.HUNT_FLOOR) || 70)),
  huntStepPct: Math.max(1, Math.min(20, Number(process.env.HUNT_STEP_PCT) || 5)),
  huntStepSec: Math.max(15, Math.min(3600, Number(process.env.HUNT_STEP_SEC) || 120)),
  // Auto risk-management — keep these ON, they protect open positions.
  breakevenEnabled: process.env.BREAKEVEN !== '0',
  trailingStopEnabled: process.env.TRAILING !== '0',
  // Safety circuit-breakers
  maxConsecutiveLosses: Math.max(0, Math.min(20, Number(process.env.MAX_CONSEC_LOSSES) || 3)),
  dailyLossLimit: Math.max(0, Number(process.env.DAILY_LOSS_LIMIT) || 0),
  dailySummaryEnabled: process.env.DAILY_SUMMARY !== '0',
  // Auto-confidence and idle fallback OFF — they were forcing marginal trades.
  autoConfidenceEnabled: process.env.AUTO_CONFIDENCE === '1',
  autoConfidenceWindow: Math.max(5, Math.min(100, Number(process.env.AUTO_CONF_WINDOW) || 20)),
  autoConfidencePercentile: Math.max(50, Math.min(95, Number(process.env.AUTO_CONF_PCT) || 75)),
  idleFallbackEnabled: process.env.IDLE_FALLBACK === '1',
  idleFallbackAfterSec: Math.max(60, Math.min(7200, Number(process.env.IDLE_FALLBACK_SEC) || 1800)),
  idleFallbackMinConfidence: Math.max(20, Math.min(80, Number(process.env.IDLE_FALLBACK_MIN) || 60)),
};
loadSettings(); // restore any saved overrides from previous runs
let autoEnabled = true;
let lastAutoRun = null, lastAutoResult = null;
let lastSignalTime = 0;
const recentScores = []; // rolling window of recent confidence scores for auto-confidence mode

async function runAutoSignal() {
  if (!autoEnabled) return;
  lastAutoRun = new Date().toISOString();
  try {
    // Position gate — only one (or N) trade in flight at a time.
    // As soon as TP/SL closes the position, the next scan is free to fire.
    if (openPositions.size >= settings.maxOpenPositions) {
      lastAutoResult = `waiting — ${openPositions.size} position(s) open, watching for TP/SL`;
      return;
    }
    // Optional time-based cooldown (default 0 = disabled). Only applies when no position is open.
    if (settings.cooldownSec > 0) {
      const sinceLast = (Date.now() - lastSignalTime) / 1000;
      if (sinceLast < settings.cooldownSec) {
        const wait = Math.ceil(settings.cooldownSec - sinceLast);
        lastAutoResult = `cooldown — next signal in ${wait}s`;
        return;
      }
    }
    const { daily, hourly } = await fetchXauMultiTF();
    const a = analyzeMarketHQ(daily.candles, hourly.candles);

    // ---- Track rolling confidence for adaptive threshold ------------------
    recentScores.push(a.confidence);
    while (recentScores.length > settings.autoConfidenceWindow) recentScores.shift();

    // ---- Compute the effective threshold ---------------------------------
    let effectiveMin = settings.minConfidence;
    let modeTag = '';

    // Auto-confidence: use percentile of recent scores +/- regime adjustment
    if (settings.autoConfidenceEnabled && recentScores.length >= 5) {
      const sorted = [...recentScores].sort((x, y) => x - y);
      const idx = Math.floor((settings.autoConfidencePercentile / 100) * (sorted.length - 1));
      let target = sorted[idx];
      // Regime adjustment: stricter in chop, looser in clean trends
      const adx = a.indicators?.adx ?? 20;
      if (adx >= 25) target -= 5;       // strong trend → easier entries
      else if (adx < 18) target += 5;   // chop → require better setups
      effectiveMin = Math.round(Math.max(settings.huntFloorConfidence, Math.min(settings.minConfidence, target)));
      modeTag = ` (auto @ ${effectiveMin}%, p${settings.autoConfidencePercentile} of ${recentScores.length})`;
    }

    // Hunt mode: relax threshold the longer we sit idle (still respects floor)
    if (settings.huntModeEnabled && lastSignalTime > 0) {
      const idleSec = (Date.now() - lastSignalTime) / 1000;
      const steps = Math.floor(idleSec / settings.huntStepSec);
      const huntMin = Math.max(settings.huntFloorConfidence, effectiveMin - steps * settings.huntStepPct);
      if (huntMin < effectiveMin) {
        effectiveMin = huntMin;
        modeTag += ` + hunt -${steps * settings.huntStepPct}`;
      }
    } else if (settings.huntModeEnabled && lastSignalTime === 0) {
      lastSignalTime = Date.now();
    }
    // ---- Idle fallback: if hunt is sitting at the floor and we still haven't
    //      fired in idleFallbackAfterSec, take whatever the engine offers as
    //      long as it clears the absolute floor. Tagged as FALLBACK in alerts.
    let isFallback = false;
    if (a.confidence < effectiveMin) {
      const atFloor = effectiveMin <= settings.huntFloorConfidence;
      const idleSec = lastSignalTime > 0 ? (Date.now() - lastSignalTime) / 1000 : 0;
      if (settings.idleFallbackEnabled && atFloor && idleSec >= settings.idleFallbackAfterSec
          && a.confidence >= settings.idleFallbackMinConfidence && a.direction) {
        isFallback = true;
        modeTag += ` + FALLBACK (idle ${Math.round(idleSec)}s)`;
      } else {
        lastAutoResult = `no signal — ${a.confidence}% < ${effectiveMin}%${modeTag}`; return;
      }
    }
    // Re-anchor entry/SL/TP from gold futures (Yahoo GC=F) to live spot (gold-api.com)
    // so what the user sees in the dashboard and Telegram matches OANDA/TradingView XAU/USD.
    try {
      const spot = await fetchSpotXau();
      const delta = spot - a.entry;
      a.entry = spot; a.sl = a.sl + delta; a.tp = a.tp + delta;
    } catch (e) { console.warn('[auto] spot anchor skipped:', e.message); }
    if (settings.rrRatio && settings.rrRatio !== 2) {
      const slDist = Math.abs(a.entry - a.sl);
      a.tp = a.direction === 'BUY' ? a.entry + slDist * settings.rrRatio : a.entry - slDist * settings.rrRatio;
    }
    const id = ++positionCounter;
    openPositions.set(id, { pair: 'XAU/USD', direction: a.direction, entry: a.entry, sl: a.sl, tp: a.tp, atr: a.atr, breakevenMoved: false, fallback: isFallback, openedAt: new Date().toISOString() });
    saveState();
    lastSignalTime = Date.now();

    // Clean trader-style format
    const header = isFallback
      ? `⚠️ FALLBACK SIGNAL`
      : (a.counterTrend ? `🔄 COUNTER-TREND SIGNAL` : `📊 SIGNAL`);
    const noteLines = [];
    if (isFallback) noteLines.push(`ℹ️ Fired after long idle (confidence ${a.confidence}%). Use minimum lot size.`);
    else if (a.counterTrend) noteLines.push(`ℹ️ Counter-trend ${a.direction} (against daily bias). Use small lot size.`);
    else noteLines.push(`⚠️ Use small lot size`);
    const riskExtra = isFallback ? ' (low-confidence)' : (a.counterTrend ? ' (counter-trend)' : '');
    const message =
      `${header}\n\n` +
      `Pair: XAU/USD\n` +
      `Type: ${a.direction}\n\n` +
      `Entry: ${fmt(a.entry)}\n` +
      `SL: ${fmt(a.sl)}\n` +
      `TP: ${fmt(a.tp)}\n\n` +
      `Risk: ${a.riskLabel}${riskExtra}\n\n` +
      noteLines.join('\n');

    await sendTelegramMessage(message);
    lastAutoResult = `${isFallback ? 'fallback' : 'signal'} sent #${id} ${a.direction} @ ${fmt(a.entry)} (${a.confidence}%)`;
    console.log(`[auto] ${lastAutoResult}`);
  } catch (e) {
    lastAutoResult = `error: ${e.message}`;
    console.error('[auto]', e.message);
  }
}
setInterval(runAutoSignal, AUTO_INTERVAL);
setTimeout(runAutoSignal, 5000);

// ---------- API routes (mounted under /api so frontend at / can coexist) ----------
const api = express.Router();

api.get('/auto', (_, res) => res.json({
  enabled: autoEnabled, intervalMinutes: AUTO_INTERVAL / 60000,
  minConfidence: settings.minConfidence, rrRatio: settings.rrRatio,
  slMultiplier: settings.slMultiplier, cooldownSec: settings.cooldownSec,
  lastRun: lastAutoRun, lastResult: lastAutoResult, openPositions: openPositions.size,
  cooldownRemaining: Math.max(0, settings.cooldownSec - Math.floor((Date.now() - lastSignalTime) / 1000)),
  telegram: {
    configured: !!(TELEGRAM_TOKEN && CHAT_ID),
    tokenSet: !!TELEGRAM_TOKEN,
    chatIdSet: !!CHAT_ID,
    lastResult: lastTelegramResult,
  },
}));

// Telegram diagnostic — tries to send a test message and returns the FULL Telegram API response.
// Hit this endpoint to find out exactly why delivery is failing (wrong token, wrong chat_id,
// bot not started by user, bot not admin in channel, etc.)
api.post('/telegram/test', async (_, res) => {
  if (!TELEGRAM_TOKEN || !CHAT_ID) {
    return res.status(400).json({ ok: false, reason: 'TELEGRAM_TOKEN and/or CHAT_ID not set in environment' });
  }
  const result = await sendTelegramMessage(`✅ Alfaview test message — ${new Date().toISOString()}`);
  res.json({ sentTo: CHAT_ID, telegramResponse: result, hint: result.ok ? 'message delivered' : telegramHint(result) });
});
api.get('/telegram/test', async (_, res) => {
  if (!TELEGRAM_TOKEN || !CHAT_ID) {
    return res.status(400).json({ ok: false, reason: 'TELEGRAM_TOKEN and/or CHAT_ID not set in environment' });
  }
  const result = await sendTelegramMessage(`✅ Alfaview test message — ${new Date().toISOString()}`);
  res.json({ sentTo: CHAT_ID, telegramResponse: result, hint: result.ok ? 'message delivered' : telegramHint(result) });
});
function telegramHint(r) {
  const code = r.error_code, desc = (r.description || '').toLowerCase();
  if (code === 401 || desc.includes('unauthorized')) return 'Bad TELEGRAM_TOKEN — check it matches the token from @BotFather exactly.';
  if (code === 400 && desc.includes('chat not found')) return 'CHAT_ID is wrong, OR the user has never sent /start to the bot, OR (for channels) the bot is not added as admin.';
  if (code === 403 && desc.includes('bot was blocked')) return 'The user blocked the bot. Unblock it in Telegram and try again.';
  if (code === 403 && desc.includes('not a member')) return 'Bot is not a member of the target group/channel. Add it (and grant post permission for channels).';
  if (code === 400 && desc.includes('chat_id is empty')) return 'CHAT_ID env var is empty.';
  return `Telegram returned: ${code || '?'} — ${r.description || 'unknown error'}`;
}
api.post('/auto/start', (_, res) => { autoEnabled = true; res.json({ enabled: true }); });
api.post('/auto/stop', (_, res) => { autoEnabled = false; res.json({ enabled: false }); });
api.post('/settings', (req, res) => {
  const b = req.body || {};
  if (b.minConfidence != null) settings.minConfidence = Math.max(0, Math.min(100, +b.minConfidence));
  if (b.rrRatio != null) settings.rrRatio = Math.max(0.1, Math.min(10, +b.rrRatio));
  if (b.slMultiplier != null) settings.slMultiplier = Math.max(0.1, Math.min(10, +b.slMultiplier));
  if (b.cooldownSec != null) settings.cooldownSec = Math.max(0, Math.min(86400, +b.cooldownSec));
  if (b.maxOpenPositions != null) settings.maxOpenPositions = Math.max(1, Math.min(10, +b.maxOpenPositions));
  if (b.huntModeEnabled != null) settings.huntModeEnabled = !!b.huntModeEnabled;
  if (b.huntFloorConfidence != null) settings.huntFloorConfidence = Math.max(40, Math.min(95, +b.huntFloorConfidence));
  if (b.huntStepPct != null) settings.huntStepPct = Math.max(1, Math.min(20, +b.huntStepPct));
  if (b.huntStepSec != null) settings.huntStepSec = Math.max(15, Math.min(3600, +b.huntStepSec));
  if (b.breakevenEnabled != null) settings.breakevenEnabled = !!b.breakevenEnabled;
  if (b.trailingStopEnabled != null) settings.trailingStopEnabled = !!b.trailingStopEnabled;
  if (b.maxConsecutiveLosses != null) settings.maxConsecutiveLosses = Math.max(0, Math.min(20, +b.maxConsecutiveLosses));
  if (b.dailyLossLimit != null) settings.dailyLossLimit = Math.max(0, +b.dailyLossLimit);
  if (b.dailySummaryEnabled != null) settings.dailySummaryEnabled = !!b.dailySummaryEnabled;
  if (b.autoConfidenceEnabled != null) settings.autoConfidenceEnabled = !!b.autoConfidenceEnabled;
  if (b.autoConfidenceWindow != null) settings.autoConfidenceWindow = Math.max(5, Math.min(100, +b.autoConfidenceWindow));
  if (b.autoConfidencePercentile != null) settings.autoConfidencePercentile = Math.max(50, Math.min(95, +b.autoConfidencePercentile));
  if (b.idleFallbackEnabled != null) settings.idleFallbackEnabled = !!b.idleFallbackEnabled;
  if (b.idleFallbackAfterSec != null) settings.idleFallbackAfterSec = Math.max(60, Math.min(7200, +b.idleFallbackAfterSec));
  if (b.idleFallbackMinConfidence != null) settings.idleFallbackMinConfidence = Math.max(20, Math.min(80, +b.idleFallbackMinConfidence));
  const saved = saveSettings();
  res.json({ ok: true, saved, persistedTo: SETTINGS_FILE, settings });
});
api.get('/settings', (_, res) => res.json({ settings, persistedTo: SETTINGS_FILE, savedFileExists: fs.existsSync(SETTINGS_FILE) }));
api.post('/settings/reset', (_, res) => {
  try { if (fs.existsSync(SETTINGS_FILE)) fs.unlinkSync(SETTINGS_FILE); } catch (_) {}
  settings.minConfidence = Math.max(50, Math.min(100, Number(process.env.MIN_CONFIDENCE) || 85));
  settings.rrRatio = Math.max(0.5, Math.min(10, Number(process.env.RR_RATIO) || 2));
  settings.slMultiplier = Math.max(0.5, Math.min(5, Number(process.env.SL_MULTIPLIER) || 1.5));
  settings.cooldownSec = Math.max(0, Math.min(86400, Number(process.env.COOLDOWN_SEC) ?? 0));
  settings.maxOpenPositions = Math.max(1, Math.min(10, Number(process.env.MAX_OPEN_POSITIONS) || 1));
  res.json({ ok: true, reset: true, settings });
});
api.get('/positions', (_, res) =>
  res.json({ count: openPositions.size, positions: [...openPositions.entries()].map(([id, p]) => ({ id, ...p })) }));
api.post('/positions/:id/close', async (req, res) => {
  const id = Number(req.params.id);
  const pos = openPositions.get(id);
  if (!pos) return res.status(404).json({ error: 'not found' });
  try {
    const m = await fetchXauUsd();
    const exit = m.close;
    openPositions.delete(id); saveState();
    const profit = pos.direction === 'BUY' ? exit - pos.entry : pos.entry - exit;
    recordClosed({ ...pos, id }, exit, profit >= 0 ? 'TP' : 'SL');
    const sign = profit >= 0 ? '+' : '';
    sendTelegramMessage(`📊 RESULT (manual)\n\nPair: ${pos.pair} #${id}\nEntry: ${fmt(pos.entry)} → Exit: ${fmt(exit)}\nP/L: ${sign}${fmt(profit)}`).catch(() => {});
    res.json({ closed: id, exit, profit });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
api.post('/positions/clear', (_, res) => {
  const n = openPositions.size; openPositions.clear(); saveState(); res.json({ cleared: n });
});
api.get('/history', (req, res) => {
  const limit = Math.min(200, Number(req.query.limit) || 50);
  res.json({ count: history.length, trades: history.slice(0, limit) });
});
api.get('/stats', (_, res) => res.json(computeStats()));
api.post('/history/clear', (_, res) => { const n = history.length; history = []; saveHistory(); res.json({ cleared: n }); });
api.get('/xauusd/price', async (_, res) => {
  try { res.json({ pair: 'XAU/USD', ...(await fetchXauUsd()) }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});
api.get('/xauusd/analysis', async (_, res) => {
  try {
    const { daily, hourly } = await fetchXauMultiTF();
    const a = analyzeMarketHQ(daily.candles, hourly.candles);
    // Re-anchor displayed entry/SL/TP to live spot price (matches OANDA/TradingView)
    try {
      const spot = await fetchSpotXau();
      const delta = spot - a.entry;
      a.entry = spot;
      if (a.sl) a.sl = a.sl + delta;
      if (a.tp) a.tp = a.tp + delta;
      a.priceSource = 'spot (gold-api.com)';
    } catch (e) { a.priceSource = 'futures (GC=F)'; }
    res.json({ pair: 'XAU/USD', asOf: new Date(hourly.meta.regularMarketTime * 1000).toISOString(), ...a });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
api.get('/health', (_, res) => res.json({ status: 'ok', uptime: Math.floor(process.uptime()) + 's' }));

app.use('/api', api);
// Alias used by the bundled React dashboard (Vite dev proxy → /api in production)
app.use('/__alfa', api);

// Serve static frontend (if public/ directory was deployed alongside server.js)
const PUBLIC_DIR = path.join(__dirname, 'public');
const HAS_FRONTEND = fs.existsSync(path.join(PUBLIC_DIR, 'index.html'));
if (HAS_FRONTEND) {
  app.use(express.static(PUBLIC_DIR));
  app.get('*', (_, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
} else {
  // Built-in fallback status page when only server.js was deployed
  app.get('/', (_, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Alfaview</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0b0f17;color:#e8ecf3;padding:24px;max-width:680px;margin:0 auto}
.card{background:#131826;border:1px solid #233047;border-radius:12px;padding:20px;margin-bottom:16px}
h1{margin:0 0 4px}.sub{color:#8a96ad;font-size:14px;margin-bottom:18px}
.row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #1c2438;font-size:14px}
.row:last-child{border-bottom:0}.k{color:#8a96ad}.v{color:#e8ecf3;font-weight:500}
.pill{padding:3px 10px;border-radius:999px;font-size:12px;font-weight:600}
.on{background:rgba(34,197,94,.15);color:#22c55e}.off{background:rgba(239,68,68,.15);color:#ef4444}
code{background:#0a0e18;padding:2px 6px;border-radius:4px;font-size:12px}
a{color:#60a5fa;text-decoration:none}</style></head><body>
<div class="card">
<h1>⚡ Alfaview</h1><div class="sub">Trading Signal Server — running headless (dashboard not deployed)</div>
<div class="row"><span class="k">Status</span><span class="v"><span class="pill on">● Running</span></span></div>
<div class="row"><span class="k">Telegram (env)</span><span class="v"><span class="pill ${TELEGRAM_TOKEN && CHAT_ID ? 'on">Configured' : 'off">Not configured'}</span></span></div>
<div class="row"><span class="k">Telegram (last delivery)</span><span class="v" id="tgstatus">—</span></div>
<div class="row"><span class="k">Auto-mode</span><span class="v" id="auto">—</span></div>
<div class="row"><span class="k">Open positions</span><span class="v" id="open">—</span></div>
<div class="row"><span class="k">Last analysis</span><span class="v" id="last">—</span></div>
<div class="row"><span class="k">Last result</span><span class="v" id="lastres">—</span></div>
<div style="margin-top:14px"><button onclick="testTg()" style="background:#2563eb;color:#fff;border:0;border-radius:8px;padding:10px 16px;font-weight:600;cursor:pointer">Send test Telegram message</button></div>
<pre id="tgresult" style="background:#0a0e18;border:1px solid #1c2438;border-radius:8px;padding:12px;font-size:12px;overflow-x:auto;margin-top:10px;display:none;white-space:pre-wrap"></pre>
</div>
<div class="card">
<h2 style="font-size:14px;text-transform:uppercase;letter-spacing:1px;color:#8a96ad;margin:0 0 12px">API endpoints</h2>
<div style="font-size:13px;line-height:1.9">
<div><a href="/api/health">/api/health</a> — server health</div>
<div><a href="/api/auto">/api/auto</a> — auto-mode + settings</div>
<div><a href="/api/positions">/api/positions</a> — open positions</div>
<div><a href="/api/history">/api/history</a> — closed trades</div>
<div><a href="/api/stats">/api/stats</a> — performance stats</div>
<div><a href="/api/xauusd/price">/api/xauusd/price</a> — live spot price</div>
</div>
<p style="color:#8a96ad;font-size:12px;margin-top:14px">To enable the full dashboard, deploy the <code>public/</code> folder alongside <code>server.js</code> from the original bundle.</p>
</div>
<script>
async function refresh(){
  try{
    const [a,p]=await Promise.all([fetch('/api/auto').then(r=>r.json()),fetch('/api/positions').then(r=>r.json())]);
    document.getElementById('auto').innerHTML='<span class="pill '+(a.enabled?'on">ON':'off">OFF')+'</span>';
    document.getElementById('open').textContent=p.count;
    document.getElementById('last').textContent=a.lastRun?new Date(a.lastRun).toLocaleTimeString():'—';
    document.getElementById('lastres').textContent=a.lastResult||'—';
    const tg=a.telegram&&a.telegram.lastResult;
    if(tg){document.getElementById('tgstatus').innerHTML=tg.ok?'<span class="pill on">✓ OK '+new Date(tg.at).toLocaleTimeString()+'</span>':'<span class="pill off">✗ '+(tg.error_code||'ERR')+' '+(tg.description||tg.networkError||'failed')+'</span>';}
    else{document.getElementById('tgstatus').textContent='not yet attempted';}
  }catch(e){}
}
async function testTg(){
  const out=document.getElementById('tgresult');out.style.display='block';out.textContent='Sending…';
  try{const r=await fetch('/api/telegram/test',{method:'POST'}).then(r=>r.json());out.textContent=JSON.stringify(r,null,2);refresh();}
  catch(e){out.textContent='Error: '+e.message;}
}
refresh();setInterval(refresh,5000);
</script></body></html>`);
  });
  // 404 anything else (no SPA fallback)
  app.use((_, res) => res.status(404).json({ error: 'not found' }));
}

const server = app.listen(PORT, '0.0.0.0', () => {
  const onRender = !!process.env.RENDER || !!process.env.RENDER_EXTERNAL_URL;
  const publicUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  console.log(`\n⚡ Alfaview listening on 0.0.0.0:${PORT}`);
  console.log(`   Dashboard: ${publicUrl}/`);
  console.log(`   API base : ${publicUrl}/api`);
  console.log(`   Health   : ${publicUrl}/api/health`);
  console.log(`   Data dir : ${DATA_DIR}`);
  console.log(`   Scan     : every ${AUTO_INTERVAL / 1000}s   Cooldown: ${settings.cooldownSec}s   MinConf: ${settings.minConfidence}%`);
  if (onRender) console.log(`   Host     : Render detected`);
  if (!TELEGRAM_TOKEN || !CHAT_ID) {
    console.log(`\n⚠️  No TELEGRAM_TOKEN / CHAT_ID set — Telegram delivery disabled.`);
    console.log(`   Set them in your Render Environment tab to enable.\n`);
  }
});

// Self-ping — keeps Render free-tier from spinning down after 15 min idle.
// Auto-enabled whenever RENDER_EXTERNAL_URL is set (i.e. running on Render).
// Disable by setting KEEPALIVE=0.
if (process.env.RENDER_EXTERNAL_URL && process.env.KEEPALIVE !== '0') {
  const url = `${process.env.RENDER_EXTERNAL_URL.replace(/\/$/, '')}/api/health`;
  const intervalMin = Math.max(2, Math.min(14, Number(process.env.KEEPALIVE_MIN) || 12));
  console.log(`   Keepalive: pinging ${url} every ${intervalMin} min (free-tier sleeps after 15)`);
  let pingCount = 0, pingFails = 0;
  const ping = () => {
    https.get(url, { timeout: 8000 }, (r) => {
      pingCount++;
      r.resume();
      if (pingCount % 10 === 0) console.log(`[keepalive] ${pingCount} pings ok, ${pingFails} failed`);
    }).on('error', (e) => { pingFails++; console.log('[keepalive] error:', e.message); })
      .on('timeout', function () { pingFails++; this.destroy(); console.log('[keepalive] timeout'); });
  };
  setInterval(ping, intervalMin * 60 * 1000);
  setTimeout(ping, 30_000); // first ping 30s after boot
}

// Graceful shutdown — Render sends SIGTERM during deploys.
function shutdown(sig) {
  console.log(`\n[${sig}] shutting down…`);
  try { saveState(); saveHistory(); } catch (_) {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 8000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));
