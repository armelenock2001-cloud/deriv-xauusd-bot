"use strict";

// ============================================
// 1. CONFIGURATION
// ============================================

const PRICE_URL =
"https://biquote.io/api/XAUUSD?allowStale=false";

const CANDLES_URL =
"https://biquote.io/api/XAUUSD/ohlc?interval=1h&limit=500";

const EMA_FAST = 50;
const EMA_SLOW = 200;
const RSI_PERIOD = 14;
const ATR_PERIOD = 14;

const SL_ATR_MULTIPLIER = 1.5;
const TP_ATR_MULTIPLIER = 3;

const PRICE_REFRESH_MS = 15000;
const ANALYSIS_REFRESH_MS = 60000;

const MIN_CANDLES_FOR_SIGNAL = 50;
const FULL_HISTORY_REQUIRED = 250;

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
refreshButton: document.getElementById("refresh-button")

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
second: "2-digit"
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

function showError(message) {
if (el.signalReason) {
el.signalReason.textContent = message;
}
}

// ============================================
// 4. RÉCUPÉRATION DU PRIX XAU/USD
// ============================================

async function fetchPrice() {
const response = await fetch(PRICE_URL, {
method: "GET",
cache: "no-store"
});

if (!response.ok) {
    throw new Error(
        `Erreur HTTP ${response.status} pendant la récupération du prix.`
    );
}

const data = await response.json();

const price = getNumber(data.mid);

if (price === null || price <= 0) {
    throw new Error(
        "Le prix reçu est invalide ou absent dans la réponse de Biquote."
    );
}

currentPrice = price;

if (el.price) {
    el.price.textContent = formatPrice(price);
}

if (el.lastUpdate) {
    el.lastUpdate.textContent = formatTime();
}

setConnection(true, "Données reçues");

return data;

}

// ============================================
// 5. NORMALISATION DES BOUGIES
// ============================================

function normalizeCandle(raw) {
const timeValue =
raw.time ??
raw.timestamp ??
raw.datetime ??
raw.date ??
raw.t;

let time;

if (typeof timeValue === "number") {
    time = timeValue;
} else if (typeof timeValue === "string") {
    const numericTime = Number(timeValue);

    time = timeValue.trim() !== "" &&
        Number.isFinite(numericTime)
        ? numericTime
        : Date.parse(timeValue);
} else {
    return null;
}

if (!Number.isFinite(time)) {
    return null;
}

// Conversion des timestamps en secondes vers millisecondes.
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

return {
    time,
    open,
    high,
    low,
    close
};

}

// ============================================
// 6. RÉCUPÉRATION DES BOUGIES H1
// ============================================

async function fetchCandles() {
const response = await fetch(CANDLES_URL, {
method: "GET",
cache: "no-store"
});

if (!response.ok) {
    throw new Error(
        `Erreur HTTP ${response.status} pendant la récupération des bougies H1.`
    );
}

const data = await response.json();

const rawBars = Array.isArray(data)
    ? data
    : Array.isArray(data.bars)
        ? data.bars
        : Array.isArray(data.candles)
            ? data.candles
            : [];

if (rawBars.length === 0) {
    throw new Error(
        "Biquote n'a retourné aucune bougie H1 reconnue."
    );
}

const now = Date.now();
const candleDuration = 60 * 60 * 1000;
const unique = new Map();

for (const raw of rawBars) {
    const candle = normalizeCandle(raw);

    if (!candle) continue;

    // Ignorer les bougies encore en formation.
    if (candle.time + candleDuration > now) continue;

    unique.set(candle.time, candle);
}

return Array.from(unique.values())
    .sort((a, b) => a.time - b.time);

}

// ============================================
// 7. CALCUL EMA
// ============================================

function calculateEMA(values, period) {
if (!values.length) return null;

const seedLength = Math.min(values.length, period);

let ema = values
    .slice(0, seedLength)
    .reduce((sum, value) => sum + value, 0) / seedLength;

const multiplier = 2 / (period + 1);

for (let i = seedLength; i < values.length; i++) {
    ema = (values[i] - ema) * multiplier + ema;
}

return ema;

}

// ============================================
// 8. CALCUL RSI
// ============================================

function calculateRSI(values, period) {
if (values.length < period + 1) return null;

let gains = 0;
let losses = 0;

for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];

    if (change > 0) {
        gains += change;
    } else {
        losses += Math.abs(change);
    }
}

let averageGain = gains / period;
let averageLoss = losses / period;

for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];

    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);

    averageGain =
        (averageGain * (period - 1) + gain) / period;

    averageLoss =
        (averageLoss * (period - 1) + loss) / period;
}

if (averageLoss === 0) return 100;

const rs = averageGain / averageLoss;

return 100 - 100 / (1 + rs);

}

// ============================================
// 9. CALCUL ATR
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

let atr = trueRanges
    .slice(0, period)
    .reduce((sum, value) => sum + value, 0) / period;

for (let i = period; i < trueRanges.length; i
