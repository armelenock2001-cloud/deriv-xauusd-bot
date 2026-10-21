"use strict";

// ============================================
// 1. CONFIGURATION
// ============================================

const API_URL = "https://biquote.io/api";
const SYMBOL = "XAUUSD";
const CANDLE_COUNT = 500;

const EMA_FAST = 50;
const EMA_SLOW = 200;
const RSI_PERIOD = 14;
const ATR_PERIOD = 14;

const SL_ATR_MULTIPLIER = 1.5;
const TP_ATR_MULTIPLIER = 3;

const PRICE_REFRESH_MS = 15000;
const ANALYSIS_REFRESH_MS = 60000;
const REQUEST_TIMEOUT_MS = 12000;

const MIN_CANDLES_FOR_SIGNAL = 50;
const FULL_HISTORY_REQUIRED = 250;

// Adresses essayées dans l'ordre (la première qui répond est utilisée)
const PRICE_URLS = [
  `${API_URL}/${SYMBOL}?allowStale=false`,
  `${API_URL}/${SYMBOL}`,
  `${API_URL}/tick/${SYMBOL}`,
];

const CANDLE_URLS = [
  `${API_URL}/${SYMBOL}/ohlc?interval=1h&limit=${CANDLE_COUNT}`,
  `${API_URL}/ohlc/${SYMBOL}?interval=1h&limit=${CANDLE_COUNT}`,
  `${API_URL}/${SYMBOL}/ohlc?interval=1h`,
];

let currentPrice = null;
let lastSignalKey = null;
let analysisRunning = false;
let historySignals = [];

// ============================================
// 2. ÉLÉMENTS HTML
// ============================================

const el = {
  price: document.getElementById("current-price"),
  lastUpdate: document.getElementById("last-update"),
  connection: document.getElementById("connection-status"),
  trend: document.getElementById("market-tendance"),
  lastAnalysis: document.getElementById("last-analysis"),

  ema50: document.getElementById("ema50"),
  ema200: document.getElementById("ema200"),
  rsi: document.getElementById("rsi"),
  atr: document.getElementById("atr"),

  signalType: document.getElementById("signal-type"),
  signalEntry: document.getElementById("signal-entry"),
  signalSL: document.getElementById("signal-sl"),
  signalTP: document.getElementById("signal-tp"),
  signalRR: document.getElementById("signal-rr"),
  signalConf: document.getElementById("signal-conf"),
  signalReason: document.getElementById("signal-reason"),
  signalTime: document.getElementById("signal-time"),

  historyTable: document.querySelector("#history-table tbody"),
  refreshButton: document.getElementById("refresh-button"),
};

// ============================================
// 3. OUTILS
// ============================================

function formatPrice(value) {
  if (!Number.isFinite(value)) return "--";
  return value.toFixed(2);
}

function formatTime(date = new Date()) {
  return date.toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function setConnection(connected, message) {
  if (!el.connection) return;
  el.connection.textContent = message;
  el.connection.className = connected
    ? "status connected"
    : "status disconnected";
}

function setSignalBadge(type, text) {
  if (!el.signalType) return;
  el.signalType.textContent = text;
  el.signalType.className = "badge " + type;
}

function getNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  return null;
}

// Télécharge du JSON avec délai maximum
async function getJSON(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

// Essaie plusieurs adresses jusqu'à obtenir une réponse valide
async function tryUrls(urls, parser, label) {
  const errors = [];

  for (const url of urls) {
    try {
      const data = await getJSON(url);
      const result = parser(data);
      if (result !== null && result !== undefined) {
        return result;
      }
      errors.push(
        `${url} → format inattendu, extrait : ` +
          JSON.stringify(data).slice(0, 250)
      );
    } catch (error) {
      errors.push(`${url} → ${error.message}`);
    }
  }

  throw new Error(`${label} impossible. Détails : ${errors.join(" | ")}`);
}

// ============================================
// 4. RÉCUPÉRATION DU PRIX
// ============================================

function parsePrice(data) {
  if (!data || typeof data !== "object") return null;

  // Réponse possible : objet, ou tableau d'objets
  const item = Array.isArray(data) ? data[0] : data;
  if (!item) return null;

  let price = getNumber(item.mid);

  if (price === null) {
    const bid = getNumber(item.bid);
    const ask = getNumber(item.ask);
    if (bid !== null && ask !== null) {
      price = (bid + ask) / 2;
    }
  }

  if (price === null) price = getNumber(item.price);
  if (price === null) price = getNumber(item.close);

  return price !== null && price > 0 ? price : null;
}

async function fetchPrice() {
  const price = await tryUrls(PRICE_URLS, parsePrice, "Récupération du prix");

  currentPrice = price;

  if (el.price) el.price.textContent = formatPrice(price);
  if (el.lastUpdate) el.lastUpdate.textContent = formatTime();

  setConnection(true, "Données reçues");

  return price;
}

// ============================================
// 5. RÉCUPÉRATION DES BOUGIES H1
// ============================================

function parseTimeString(text) {
  const t = text.trim();

  const mt = t.match(
    /^(\d{4})[.\-\/](\d{2})[.\-\/](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/
  );

  if (mt) {
    return Date.UTC(
      Number(mt[1]),
      Number(mt[2]) - 1,
      Number(mt[3]),
      Number(mt[4]),
      Number(mt[5]),
      Number(mt[6] || 0)
    );
  }

  return Date.parse(t);
}

function normalizeCandle(raw) {
  if (!raw || typeof raw !== "object") return null;

  const timeValue =
    raw.time ?? raw.timestamp ?? raw.datetime ?? raw.date ?? raw.t;

  let time;

  if (typeof timeValue === "number") {
    time = timeValue;
  } else if (typeof timeValue === "string") {
    const numericTime = Number(timeValue);
    time =
      Number.isFinite(numericTime) && timeValue.trim() !== ""
        ? numericTime
        : parseTimeString(timeValue);
  } else {
    return null;
  }

  if (!Number.isFinite(time)) return null;

  // Conversion des secondes en millisecondes si nécessaire
  if (time < 100000000000) {
    time *= 1000;
  }

  const open = getNumber(raw.open ?? raw.o);
  const high = getNumber(raw.high ?? raw.h);
  const low = getNumber(raw.low ?? raw.l);
  const close = getNumber(raw.close ?? raw.c);

  if (
    open === null ||
    high === null ||
    low === null ||
    close === null ||
    high < low
  ) {
    return null;
  }

  return { time, open, high, low, close };
}

function findArray(obj, depth = 0) {
  if (Array.isArray(obj)) return obj;
  if (!obj || typeof obj !== "object" || depth > 3) return null;

  for (const value of Object.values(obj)) {
    const found = findArray(value, depth + 1);
    if (found && found.length) return found;
  }

  return null;
}

function parseCandles(data) {
  const rawBars = findArray(data) || [];

  if (rawBars.length === 0) return null;

  const now = Date.now();
  const candleDuration = 60 * 60 * 1000;
  const unique = new Map();

  for (const raw of rawBars) {
    const candle = normalizeCandle(raw);
    if (!candle) continue;

    // Garder uniquement les bougies H1 clôturées
    if (candle.time + candleDuration > now) continue;

    unique.set(candle.time, candle);
  }

  if (unique.size === 0) return null;

  return Array.from(unique.values()).sort((a, b) => a.time - b.time);
}

async function fetchCandles() {
  return tryUrls(CANDLE_URLS, parseCandles, "Récupération des bougies H1");
}

// ============================================
// 6. CALCUL EMA
// ============================================

function calculateEMA(values, period) {
  if (!values.length) return null;

  const seedLength = Math.min(values.length, period);

  let ema =
    values.slice(0, seedLength).reduce((sum, v) => sum + v, 0) / seedLength;

  const multiplier = 2 / (period + 1);

  for (let i = seedLength; i < values.length; i++) {
    ema = (values[i] - ema) * multiplier + ema;
  }

  return ema;
}

// ============================================
// 7. CALCUL RSI
// ============================================

function calculateRSI(values, period) {
  if (values.length < period + 1) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }

  let averageGain = gains / period;
  let averageLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);

    averageGain = (averageGain * (period - 1) + gain) / period;
    averageLoss = (averageLoss * (period - 1) + loss) / period;
  }

  if (averageLoss === 0) return 100;

  const rs = averageGain / averageLoss;
  return 100 - 100 / (1 + rs);
}

// ============================================
// 8. CALCUL ATR
// ============================================

function calculateATR(candles, period) {
  if (candles.length < period + 1) return null;

  const trueRanges = [];

  for (let i = 1; i < candles.length; i++) {
    const candle = candles[i];
    const previousClose = candles[i - 1].close;

    trueRanges.push(
      Math.max(
        candle.high - candle.low,
        Math.abs(candle.high - previousClose),
        Math.abs(candle.low - previousClose)
      )
    );
  }

  if (trueRanges.length < period) return null;

  let atr = trueRanges.slice(0, period).reduce((sum, v) => sum + v, 0) / period;

  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
  }

  return atr;
}

// ============================================
// 9. AFFICHAGE DES INDICATEURS
// ============================================

function displayIndicators(ema50, ema200, rsi, atr, candleCount) {
  if (el.ema50) el.ema50.textContent = formatPrice(ema50);

  if (el.ema200) {
    el.ema200.textContent =
      formatPrice(ema200) + (candleCount < EMA_SLOW ? " *" : "");
  }

  if (el.rsi) {
    el.rsi.textContent = Number.isFinite(rsi) ? rsi.toFixed(2) : "--";
  }

  if (el.atr) el.atr.textContent = formatPrice(atr);
}

// ============================================
// 10. HISTORIQUE DES SIGNAUX
// ============================================

function addSignalToHistory(signal) {
  if (historySignals.some((item) => item.key === signal.key)) return;

  historySignals.unshift(signal);
  historySignals = historySignals.slice(0, 30);

  renderHistory();
}

function renderHistory() {
  if (!el.historyTable) return;

  el.historyTable.replaceChildren();

  for (const signal of historySignals) {
    const row = document.createElement("tr");

    const values = [
      signal.time,
      signal.type,
      formatPrice(signal.entry),
      `${formatPrice(signal.sl)} / ${formatPrice(signal.tp)}`,
      signal.trend,
    ];

    for (const value of values) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.appendChild(cell);
    }

    el.historyTable.appendChild(row);
  }
}

// ============================================
// 11. RÉINITIALISATION DU SIGNAL
// ============================================

function clearSignal(message = "Aucun signal pour le moment.") {
  setSignalBadge("none", "AUCUN SIGNAL");

  if (el.signalEntry) el.signalEntry.textContent = "--";
  if (el.signalSL) el.signalSL.textContent = "--";
  if (el.signalTP) el.signalTP.textContent = "--";
  if (el.signalRR) el.signalRR.textContent = "--";
  if (el.signalConf) el.signalConf.textContent = "--";
  if (el.signalTime) el.signalTime.textContent = "--";
  if (el.signalReason) el.signalReason.textContent = message;
}

// ============================================
// 12. ANALYSE DU MARCHÉ
// ============================================

async function analyzeMarket() {
  if (analysisRunning) return;

  analysisRunning = true;

  if (el.refreshButton) el.refreshButton.disabled = true;

  try {
    if (el.signalReason) {
      el.signalReason.textContent = "Récupération des données H1...";
    }

    const [priceResult, candlesResult] = await Promise.allSettled([
      fetchPrice(),
      fetchCandles(),
    ]);

    // Le prix peut s'afficher même si les bougies échouent
    if (priceResult.status === "rejected") {
      setConnection(false, "Erreur de connexion");
      console.error("Prix :", priceResult.reason);
    }

    if (candlesResult.status === "rejected") {
      console.error("Bougies :", candlesResult.reason);

      if (el.trend) el.trend.textContent = "Indisponible";

      clearSignal(
        `Erreur : ${candlesResult.reason.message}. ` +
          "Si les liens API fonctionnent dans le navigateur, " +
          "le problème peut venir de CORS."
      );

      if (priceResult.status === "fulfilled") {
        setConnection(false, "Bougies indisponibles");
      }

      return;
    }

    if (priceResult.status === "rejected" && currentPrice === null) {
      // Dernier recours : utiliser la clôture de la dernière bougie
      const fallbackCandles = candlesResult.value;
      currentPrice = fallbackCandles[fallbackCandles.length - 1].close;

      if (el.price) el.price.textContent = formatPrice(currentPrice);
    }

    const candles = candlesResult.value;

    if (candles.length < MIN_CANDLES_FOR_SIGNAL) {
      if (el.trend) el.trend.textContent = "Historique insuffisant";

      if (el.ema50) el.ema50.textContent = "--";
      if (el.ema200) el.ema200.textContent = "--";
      if (el.rsi) el.rsi.textContent = "--";
      if (el.atr) el.atr.textContent = "--";

      clearSignal(
        `Biquote fournit seulement ${candles.length} bougies H1 clôturées. ` +
          `Il en faut au moins ${MIN_CANDLES_FOR_SIGNAL} pour une analyse exploitable.`
      );

      if (el.lastAnalysis) el.lastAnalysis.textContent = formatTime();
      return;
    }

    const closes = candles.map((c) => c.close);

    const ema50 = calculateEMA(closes, EMA_FAST);
    const ema200 = calculateEMA(closes, EMA_SLOW);
    const rsi = calculateRSI(closes, RSI_PERIOD);
    const atr = calculateATR(candles, ATR_PERIOD);

    displayIndicators(ema50, ema200, rsi, atr, candles.length);

    if (
      ema50 === null ||
      ema200 === null ||
      rsi === null ||
      atr === null ||
      atr <= 0
    ) {
      if (el.trend) el.trend.textContent = "Analyse indisponible";

      clearSignal(
        "Les données reçues ne permettent pas de calculer tous les indicateurs."
      );
      return;
    }

    const last = candles[candles.length - 1];
    const previous = candles[candles.length - 2];
    const price = currentPrice ?? last.close;

    let trend = "NEUTRE";

    if (ema50 > ema200 && price > ema50) {
      trend = "HAUSSIÈRE";
    } else if (ema50 < ema200 && price < ema50) {
      trend = "BAISSIÈRE";
    }

    if (el.trend) el.trend.textContent = trend;

    const bullishCandle = last.close > last.open;
    const bearishCandle = last.close < last.open;

    // Signal 1 : continuation de tendance
    const buyTrend =
      ema50 > ema200 &&
      last.close > ema50 &&
      rsi >= 50 &&
      rsi <= 68 &&
      bullishCandle &&
      last.close > previous.close;

    const sellTrend =
      ema50 < ema200 &&
      last.close < ema50 &&
      rsi >= 32 &&
      rsi <= 50 &&
      bearishCandle &&
      last.close < previous.close;

    // Signal 2 : repli sur l'EMA 50 puis reprise (plus fréquent)
    const touchedEMA50Up =
      ema50 > ema200 &&
      previous.low <= ema50 + atr * 0.3 &&
      last.close > ema50 &&
      bullishCandle &&
      rsi > 45 &&
      rsi < 70;

    const touchedEMA50Down =
      ema50 < ema200 &&
      previous.high >= ema50 - atr * 0.3 &&
      last.close < ema50 &&
      bearishCandle &&
      rsi < 55 &&
      rsi > 30;

    const buySignal = buyTrend || touchedEMA50Up;
    const sellSignal = sellTrend || touchedEMA50Down;

    const warnings = [];

    if (candles.length < EMA_SLOW) {
      warnings.push(
        `EMA 200 provisoire : ${candles.length} bougies disponibles, 200 recommandées`
      );
    } else if (candles.length < FULL_HISTORY_REQUIRED) {
      warnings.push(`Historique limité (${candles.length} bougies H1)`);
    }

    const entry = price;
    let signalType = "NONE";
    let sl = null;
    let tp = null;

    if (buySignal && !sellSignal) {
      signalType = "BUY";
      sl = entry - atr * SL_ATR_MULTIPLIER;
      tp = entry + atr * TP_ATR_MULTIPLIER;
    } else if (sellSignal && !buySignal) {
      signalType = "SELL";
      sl = entry + atr * SL_ATR_MULTIPLIER;
      tp = entry - atr * TP_ATR_MULTIPLIER;
    }

    if (signalType === "BUY" || signalType === "SELL") {
      // Un seul signal par bougie et par direction
      const signalKey = `${signalType}-${last.time}`;

      setSignalBadge(
        signalType === "BUY" ? "buy" : "sell",
        signalType === "BUY" ? "ACHAT" : "VENTE"
      );

      if (el.signalEntry) el.signalEntry.textContent = formatPrice(entry);
      if (el.signalSL) el.signalSL.textContent = formatPrice(sl);
      if (el.signalTP) el.signalTP.textContent = formatPrice(tp);
      if (el.signalRR) el.signalRR.textContent = "1:2";

      if (el.signalConf) {
        el.signalConf.textContent = warnings.length
          ? "Conditions réunies — prudence"
          : "Conditions techniques réunies";
      }

      if (el.signalTime) el.signalTime.textContent = formatTime();

      if (el.signalReason) {
        el.signalReason.textContent =
          `${ signalType === "BUY" ? "Signal d'achat" : "Signal de vente" } détecté sur H1. ` +
          `Tendance : ${trend}. EMA 50 : ${formatPrice(ema50)}. ` +
          `EMA 200 : ${formatPrice(ema200)}. RSI : ${rsi.toFixed(2)}. ` +
          `ATR : ${formatPrice(atr)}. ` +
          (warnings.length ? warnings.join(". ") + ". " : "") +
          "Signal indicatif : aucun gain n'est garanti.";
      }

      if (signalKey !== lastSignalKey) {
        lastSignalKey = signalKey;

        addSignalToHistory({
          key: signalKey,
          type: signalType === "BUY" ? "ACHAT" : "VENTE",
          entry,
          sl,
          tp,
          trend,
          time: formatTime(),
        });
      }
    } else {
      clearSignal(
        `Aucun signal H1 pour le moment. Tendance : ${trend}. ` +
          `EMA 50 : ${formatPrice(ema50)}. ` +
          `EMA 200 : ${formatPrice(ema200)}. ` +
          `RSI : ${rsi.toFixed(2)}. ATR : ${formatPrice(atr)}. ` +
          (warnings.length ? warnings.join(". ") + ". " : "") +
          "Le robot attend que les conditions d'entrée soient réunies."
      );

      if (el.signalConf) {
        el.signalConf.textContent = "Conditions non réunies";
      }
    }

    if (el.lastAnalysis) el.lastAnalysis.textContent = formatTime();
  } catch (error) {
    console.error("Erreur d'analyse :", error);

    setConnection(false, "Erreur de connexion");

    if (el.signalReason) {
      el.signalReason.textContent = `Erreur : ${ error.message || "récupération des données impossible" }.`;
    }

    if (el.trend) el.trend.textContent = "Indisponible";
  } finally {
    analysisRunning = false;

    if (el.refreshButton) el.refreshButton.disabled = false;
  }
}

// ============================================
// 13. DÉMARRAGE AUTOMATIQUE
// ============================================

if (el.refreshButton) {
  el.refreshButton.addEventListener("click", analyzeMarket);
}

// Première analyse automatique
analyzeMarket();

// Actualisation du prix toutes les 15 secondes
setInterval(async () => {
  try {
    await fetchPrice();
  } catch (error) {
    console.error("
