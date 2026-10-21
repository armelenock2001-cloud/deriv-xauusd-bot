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

for (let i = period; i < trueRanges.length; i++) {
    atr =
        (atr * (period - 1) + trueRanges[i]) / period;
}

return atr;

}

// ============================================
// 10. AFFICHAGE DES INDICATEURS
// ============================================

function displayIndicators(ema50, ema200, rsi, atr, candleCount) {
if (el.ema50) {
el.ema50.textContent = formatPrice(ema50);
}

if (el.ema200) {
    el.ema200.textContent =
        formatPrice(ema200) +
        (candleCount < EMA_SLOW ? " *" : "");
}

if (el.rsi) {
    el.rsi.textContent =
        Number.isFinite(rsi) ? rsi.toFixed(2) : "--";
}

if (el.atr) {
    el.atr.textContent = formatPrice(atr);
}

}

// ============================================
// 11. HISTORIQUE DES SIGNAUX
// ============================================

function addSignalToHistory(signal) {
if (historySignals.some(item => item.key === signal.key)) {
return;
}

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
        signal.trend
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
// 12. AFFICHAGE SANS SIGNAL
// ============================================

function clearSignal(message) {
setSignalBadge("none", "AUCUN SIGNAL");

if (el.signalEntry) el.signalEntry.textContent = "--";
if (el.signalSL) el.signalSL.textContent = "--";
if (el.signalTP) el.signalTP.textContent = "--";
if (el.signalRR) el.signalRR.textContent = "--";
if (el.signalConf) el.signalConf.textContent = "--";
if (el.signalTime) el.signalTime.textContent = "--";

showError(message);

}

// ============================================
// 13. ANALYSE AUTOMATIQUE DU MARCHÉ
// ============================================

async function analyzeMarket() {
if (analysisRunning) return;

analysisRunning = true;

if (el.refreshButton) {
    el.refreshButton.disabled = true;
}

try {
    showError("Récupération des données H1...");

    const results = await Promise.allSettled([
        fetchPrice(),
        fetchCandles()
    ]);

    if (results[0].status === "rejected") {
        throw results[0].reason;
    }

    if (results[1].status === "rejected") {
        throw results[1].reason;
    }

    const candles = results[1].value;

    if (candles.length < MIN_CANDLES_FOR_SIGNAL) {
        if (el.trend) {
            el.trend.textContent = "Historique insuffisant";
        }

        if (el.ema50) el.ema50.textContent = "--";
        if (el.ema200) el.ema200.textContent = "--";
        if (el.rsi) el.rsi.textContent = "--";
        if (el.atr) el.atr.textContent = "--";

        clearSignal(
            `Seulement ${candles.length} bougies H1 clôturées ont été reçues. ` +
            `Il en faut au moins ${MIN_CANDLES_FOR_SIGNAL} pour analyser le marché.`
        );

        if (el.lastAnalysis) {
            el.lastAnalysis.textContent = formatTime();
        }

        return;
    }

    const closes = candles.map(candle => candle.close);

    const ema50 = calculateEMA(closes, EMA_FAST);
    const ema200 = calculateEMA(closes, EMA_SLOW);
    const rsi = calculateRSI(closes, RSI_PERIOD);
    const atr = calculateATR(candles, ATR_PERIOD);

    displayIndicators(
        ema50,
        ema200,
        rsi,
        atr,
        candles.length
    );

    if (
        ema50 === null ||
        ema200 === null ||
        rsi === null ||
        atr === null ||
        atr <= 0
    ) {
        if (el.trend) {
            el.trend.textContent = "Analyse indisponible";
        }

        clearSignal(
            "Les données reçues ne permettent pas de calculer tous les indicateurs."
        );

        return;
    }

    const last = candles[candles.length - 1];
    const previous = candles[candles.length - 2];

    const provisionalEMA = candles.length < EMA_SLOW;

    let trend = "NEUTRE";

    if (ema50 > ema200 && last.close > ema50) {
        trend = "HAUSSIÈRE";
    } else if (ema50 < ema200 && last.close < ema50) {
        trend = "BAISSIÈRE";
    }

    if (el.trend) {
        el.trend.textContent = trend;
    }

    const bullishCandle = last.close > last.open;
    const bearishCandle = last.close < last.open;

    const buySignal =
        ema50 > ema200 &&
        last.close > ema50 &&
        rsi >= 50 &&
        rsi <= 68 &&
        bullishCandle &&
        last.close > previous.close;

    const sellSignal =
        ema50 < ema200 &&
        last.close < ema50 &&
        rsi >= 32 &&
        rsi <= 50 &&
        bearishCandle &&
        last.close < previous.close;

    const warnings = [];

    if (provisionalEMA) {
        warnings.push(
            `EMA 200 provisoire : ${candles.length} bougies disponibles`
        );
    }

    if (candles.length < FULL_HISTORY_REQUIRED) {
        warnings.push(
            `Historique limité : ${candles.length} bougies H1`
        );
    }

    const entry = currentPrice;

    let signalType = "NONE";
    let sl = null;
    let tp = null;

    if (buySignal) {
        signalType = "BUY";
        sl = entry - atr * SL_ATR_MULTIPLIER;
        tp = entry + atr * TP_ATR_MULTIPLIER;
    } else if (sellSignal) {
        signalType = "SELL";
        sl = entry + atr * SL_ATR_MULTIPLIER;
        tp = entry - atr * TP_ATR_MULTIPLIER;
    }

    if (signalType === "BUY" || signalType === "SELL") {
        const signalKey =
            `${signalType}-${last.time}-${formatPrice(entry)}`;

        setSignalBadge(
            signalType === "BUY" ? "buy" : "sell",
            signalType === "BUY" ? "ACHAT" : "VENTE"
        );

        if (el.signalEntry) {
            el.signalEntry.textContent = formatPrice(entry);
        }

        if (el.signalSL) {
            el.signalSL.textContent = formatPrice(sl);
        }

        if (el.signalTP) {
            el.signalTP.textContent = formatPrice(tp);
        }

        if (el.signalRR) {
            el.signalRR.textContent = "1:2";
        }

        if (el.signalConf) {
            el.signalConf.textContent = warnings.length
                ? "Conditions réunies — prudence"
                : "Conditions techniques réunies";
        }

        if (el.signalTime) {
            el.signalTime.textContent = formatTime();
        }

        showError(
            `${signalType === "BUY" ? "Signal d'achat" : "Signal de vente"} H1 détecté. ` +
            `Tendance : ${trend}. ` +
            `EMA 50 : ${formatPrice(ema50)}. ` +
            `EMA 200 : ${formatPrice(ema200)}. ` +
            `RSI : ${rsi.toFixed(2)}. ` +
            `ATR : ${formatPrice(atr)}. ` +
            (warnings.length ? warnings.join(". ") + ". " : "") +
            "Signal indicatif : aucun bénéfice n'est garanti."
        );

        if (signalKey !== lastSignalKey) {
            lastSignalKey = signalKey;

            addSignalToHistory({
                key: signalKey,
                type: signalType === "BUY" ? "ACHAT" : "VENTE",
                entry,
                sl,
                tp,
                trend,
                time: formatTime()
            });
        }
    } else {
        clearSignal(
            `Aucun signal H1 pour le moment. Tendance : ${trend}. ` +
            `EMA 50 : ${formatPrice(ema50)}. ` +
            `EMA 200 : ${formatPrice(ema200)}. ` +
            `RSI : ${rsi.toFixed(2)}. ` +
            `ATR : ${formatPrice(atr)}. ` +
            (warnings.length ? warnings.join(". ") + ". " : "") +
            "Le robot attend que les conditions d'entrée soient réunies."
        );

        if (el.signalConf) {
            el.signalConf.textContent = "Conditions non réunies";
        }
    }

    if (el.lastAnalysis) {
        el.lastAnalysis.textContent = formatTime();
    }

} catch (error) {
    console.error("Erreur d'analyse :", error);

    setConnection(false, "Erreur de connexion");

    if (el.trend) {
        el.trend.textContent = "Indisponible";
    }

    showError(
        `Erreur : ${error.message || "récupération des données impossible"}. ` +
        "Vérifie les URL et la disponibilité de l'API."
    );

} finally {
    analysisRunning = false;

    if (el.refreshButton) {
        el.refreshButton.disabled = false;
    }
}

}

// ============================================
// 14. DÉMARRAGE AUTOMATIQUE
// ============================================

if (el.refreshButton) {
el.refreshButton.addEventListener("click", analyzeMarket);
}

// Première analyse au chargement.
analyzeMarket();

// Actualisation du prix toutes les 15 secondes.
setInterval(async () => {
try {
await fetchPrice();
} catch (error) {
console.error("Erreur de mise à jour du prix :", error);
setConnection(false, "Connexion interrompue");
}
}, PRICE_REFRESH_MS);

// Nouvelle analyse toutes les 60 secondes.
setInterval(analyzeMarket, ANALYSIS_REFRESH_MS);
