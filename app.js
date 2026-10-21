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
const RECOMMENDED_CANDLES_FOR_EMA200 = 250;
const CANDLE_DURATION_MS = 60 * 60 * 1000;

// Adresses de récupération du prix
const PRICE_URLS = [
    `${API_URL}/${SYMBOL}`
];

// Adresses de récupération des bougies (ciblage de l'endpoint valide Biquote)
const CANDLE_URLS = [
    `${API_URL}/${SYMBOL}/ohlc?interval=1h&limit=${CANDLE_COUNT}`
];

let currentPrice = null;
let lastSignalKey = null;
let analysisRunning = false;
let priceRefreshRunning = false;
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
// 3. OUTILS GÉNÉRAUX
// ============================================

function formatPrice(value) {
    return Number.isFinite(value) ? value.toFixed(2) : "--";
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
    el.signalType.className = `badge ${type}`;
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

function updateText(element, value) {
    if (element) element.textContent = value;
}

// ============================================
// 4. REQUÊTES API
// ============================================

async function getJSON(url) {
    const controller = new AbortController();

    const timer = setTimeout(
        () => controller.abort(),
        REQUEST_TIMEOUT_MS
    );

    try {
        const response = await fetch(url, {
            method: "GET",
            cache: "no-store",
            signal: controller.signal,
            headers: {
                Accept: "application/json"
            }
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        return await response.json();

    } catch (error) {
        if (error.name === "AbortError") {
            throw new Error("Délai de connexion dépassé");
        }

        if (error instanceof TypeError) {
            throw new Error(
                "Échec du réseau ou accès API bloqué par CORS"
            );
        }

        throw error;

    } finally {
        clearTimeout(timer);
    }
}

async function tryUrls(urls, parser, label) {
    const errors = [];

    for (const url of urls) {
        try {
            const data = await getJSON(url);
            const result = parser(data);

            if (result !== null && result !== undefined) {
                return result;
            }

            errors.push(`${url} : format de réponse non reconnu`);

        } catch (error) {
            errors.push(`${url} : ${error.message}`);
        }
    }

    throw new Error(`${label} impossible. ${errors.join(" | ")}`);
}

// ============================================
// 5. RÉCUPÉRATION DU PRIX XAU/USD
// ============================================

function parsePrice(data) {
    if (!data || typeof data !== "object") {
        return null;
    }

    const item = Array.isArray(data) ? data[0] : data;

    if (!item || typeof item !== "object") {
        return null;
    }

    let price = getNumber(item.mid);

    if (price === null) {
        const bid = getNumber(item.bid);
        const ask = getNumber(item.ask);

        if (bid !== null && ask !== null && bid > 0 && ask > 0) {
            price = (bid + ask) / 2;
        }
    }

    if (price === null) price = getNumber(item.price);
    if (price === null) price = getNumber(item.close);

    if (price === null && item.data) {
        return parsePrice(item.data);
    }

    return price !== null && price > 0 ? price : null;
}

async function fetchPrice() {
    const price = await tryUrls(
        PRICE_URLS,
        parsePrice,
        "Récupération du prix"
    );

    currentPrice = price;

    updateText(el.price, formatPrice(price));
    updateText(el.lastUpdate, formatTime());

    setConnection(true, "Données reçues");

    return price;
}

// ============================================
// 6. NORMALISATION DES BOUGIES
// ============================================

function parseTimeValue(value) {
    if (typeof value === "number") {
        return value < 100000000000
            ? value * 1000
            : value;
    }

    if (typeof value !== "string" || !value.trim()) {
        return null;
    }

    const trimmed = value.trim();
    const numeric = Number(trimmed);

    if (Number.isFinite(numeric)) {
        return numeric < 100000000000
            ? numeric * 1000
            : numeric;
    }

    const parsed = Date.parse(trimmed);

    return Number.isFinite(parsed) ? parsed : null;
}

function normalizeCandle(raw) {
    if (!raw || typeof raw !== "object") {
        return null;
    }

    const timeValue =
        raw.openTime ??
        raw.time ??
        raw.timestamp ??
        raw.datetime ??
        raw.date ??
        raw.t;

    const time = parseTimeValue(timeValue);

    if (time === null || !Number.isFinite(time)) {
        return null;
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
        open <= 0 ||
        high <= 0 ||
        low <= 0 ||
        close <= 0 ||
        high < low ||
        high < open ||
        high < close ||
        low > open ||
        low > close
    ) {
        return null;
    }

    return {
        time,
        open,
        high,
        low,
        close,
        isOpen: raw.isOpen === true
    };
}

// ============================================
// 7. LECTURE DES BOUGIES BIQUOTE
// ============================================

function extractRawCandles(data) {
    if (Array.isArray(data)) {
        return data;
    }

    if (!data || typeof data !== "object") {
        return null;
    }

    if (Array.isArray(data.bars)) {
        return data.bars;
    }

    if (Array.isArray(data.candles)) {
        return data.candles;
    }

    if (Array.isArray(data.data)) {
        return data.data;
    }

    if (data.data && typeof data.data === "object") {
        return extractRawCandles(data.data);
    }

    if (data.result && typeof data.result === "object") {
        return extractRawCandles(data.result);
    }

    return null;
}

function parseCandles(data) {
    const rawBars = extractRawCandles(data);

    if (!rawBars || rawBars.length === 0) {
        return null;
    }

    const unique = new Map();

    for (const raw of rawBars) {
        const candle = normalizeCandle(raw);

        if (!candle) continue;

        // Ajout direct sans filtrage temporel restrictif pour éviter les tableaux vides
        unique.set(candle.time, candle);
    }

    if (unique.size === 0) {
        return null;
    }

    const candles = Array.from(unique.values())
        .sort((a, b) => a.time - b.time);

    return candles.slice(-CANDLE_COUNT);
}

async function fetchCandles() {
    return tryUrls(
        CANDLE_URLS,
        parseCandles,
        "Récupération des bougies H1"
    );
}

// ============================================
// 8. CALCUL DE L'EMA
// ============================================

function calculateEMA(values, period) {
    if (
        !Array.isArray(values) ||
        values.length < period ||
        period <= 0
    ) {
        return null;
    }

    let ema = values
        .slice(0, period)
        .reduce((sum, value) => sum + value, 0) / period;

    const multiplier = 2 / (period + 1);

    for (let i = period; i < values.length; i++) {
        ema = (values[i] - ema) * multiplier + ema;
    }

    return Number.isFinite(ema) ? ema : null;
}

// ============================================
// 9. CALCUL DU RSI — MÉTHODE DE WILDER
// ============================================

function calculateRSI(values, period) {
    if (
        !Array.isArray(values) ||
        values.length < period + 1
    ) {
        return null;
    }

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

    if (averageGain === 0 && averageLoss === 0) {
        return 50;
    }

    if (averageLoss === 0) {
        return 100;
    }

    if (averageGain === 0) {
        return 0;
    }

    const rs = averageGain / averageLoss;

    return 100 - 100 / (1 + rs);
}

// ============================================
// 10. CALCUL DE L'ATR — MÉTHODE DE WILDER
// ============================================

function calculateATR(candles, period) {
    if (
        !Array.isArray(candles) ||
        candles.length < period + 1
    ) {
        return null;
    }

    const trueRanges = [];

    for (let i = 1; i < candles.length; i++) {
        const candle = candles[i];
        const previousClose = candles[i - 1].close;

        const trueRange = Math.max(
            candle.high - candle.low,
            Math.abs(candle.high - previousClose),
            Math.abs(candle.low - previousClose)
        );

        trueRanges.push(trueRange);
    }

    if (trueRanges.length < period) {
        return null;
    }

    let atr = trueRanges
        .slice(0, period)
        .reduce((sum, value) => sum + value, 0) / period;

    for (let i = period; i < trueRanges.length; i++) {
        atr = (
            atr * (period - 1) + trueRanges[i]
        ) / period;
    }

    return Number.isFinite(atr) ? atr : null;
}

// ============================================
// 11. AFFICHAGE DES INDICATEURS
// ============================================

function displayIndicators(ema50, ema200, rsi, atr, candleCount) {
    updateText(el.ema50, formatPrice(ema50));

    let ema200Text = formatPrice(ema200);

    if (candleCount < RECOMMENDED_CANDLES_FOR_EMA200) {
        ema200Text += " *";
    }

    updateText(el.ema200, ema200Text);

    updateText(
        el.rsi,
        Number.isFinite(rsi) ? rsi.toFixed(2) : "--"
    );

    updateText(el.atr, formatPrice(atr));
}

// ============================================
// 12. HISTORIQUE DES SIGNAUX
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
// 13. RÉINITIALISATION DE L'AFFICHAGE DU SIGNAL
// ============================================

function clearSignal(message = "Aucun signal pour le moment.") {
    setSignalBadge("none", "AUCUN SIGNAL");

    updateText(el.signalEntry, "--");
    updateText(el.signalSL, "--");
    updateText(el.signalTP, "--");
    updateText(el.signalRR, "--");
    updateText(el.signalConf, "--");
    updateText(el.signalTime, "--");
    updateText(el.signalReason, message);
}

// ============================================
// 14. DÉTECTION ET ANALYSE DU MARCHÉ
// ============================================

async function analyzeMarket() {
    if (analysisRunning) return;

    analysisRunning = true;

    if (el.refreshButton) {
        el.refreshButton.disabled = true;
    }

    try {
        updateText(
            el.signalReason,
            "Récupération du prix et des bougies H1..."
        );

        const [priceResult, candlesResult] =
            await Promise.allSettled([
                fetchPrice(),
                fetchCandles()
            ]);

        if (priceResult.status === "rejected") {
            console.error("Erreur prix :", priceResult.reason);
        }

        if (candlesResult.status === "rejected") {
            console.error("Erreur bougies :", candlesResult.reason);

            updateText(el.trend, "Indisponible");

            clearSignal(
                `Erreur de récupération des bougies : ` +
                `${candlesResult.reason.message}.`
            );

            if (priceResult.status === "rejected") {
                setConnection(false, "Connexion indisponible");
            } else {
                setConnection(false, "Prix reçu, bougies indisponibles");
            }

            updateText(el.lastAnalysis, formatTime());

            return;
        }

        const candles = candlesResult.value;

        if (!Array.isArray(candles) || candles.length === 0) {
            throw new Error("Aucune bougie H1 valide reçue.");
        }

        if (
            priceResult.status === "rejected" &&
            currentPrice === null
        ) {
            currentPrice = candles[candles.length - 1].close;
            updateText(el.price, formatPrice(currentPrice));
        }

        if (candles.length < MIN_CANDLES_FOR_SIGNAL) {
            updateText(el.trend, "Historique insuffisant");

            updateText(el.ema50, "--");
            updateText(el.ema200, "--");
            updateText(el.rsi, "--");
            updateText(el.atr, "--");

            clearSignal(
                `Seulement ${candles.length} bougies H1 disponibles. ` +
                `Il en faut au moins ${MIN_CANDLES_FOR_SIGNAL} pour poursuivre ` +
                `l'analyse.`
            );

            updateText(el.lastAnalysis, formatTime());

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
            updateText(el.trend, "Historique insuffisant");

            clearSignal(
                "Impossible de calculer tous les indicateurs. " +
                "Pour l'EMA 200, il faut au minimum 200 bougies H1."
            );

            updateText(el.lastAnalysis, formatTime());

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

        updateText(el.trend, trend);

        const bullishCandle = last.close > last.open;
        const bearishCandle = last.close < last.open;

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

        if (candles.length < RECOMMENDED_CANDLES_FOR_EMA200) {
            warnings.push(
                `Historique limité : ${candles.length} bougies disponibles.`
            );
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
            const signalKey = `${signalType}-${last.time}`;

            setSignalBadge(
                signalType === "BUY" ? "buy" : "sell",
                signalType === "BUY" ? "ACHAT" : "VENTE"
            );

            updateText(el.signalEntry, formatPrice(entry));
            updateText(el.signalSL, formatPrice(sl));
            updateText(el.signalTP, formatPrice(tp));

            updateText(el.signalRR, "1:2");

            updateText(
                el.signalConf,
                warnings.length
                    ? "Conditions réunies — prudence"
                    : "Conditions techniques réunies"
            );

            updateText(el.signalTime, formatTime());

            updateText(
                el.signalReason,
                `${signalType === "BUY" ? "Signal d'achat" : "Signal de vente"} ` +
                `détecté sur H1. ` +
                `Tendance : ${trend}. ` +
                `EMA 50 : ${formatPrice(ema50)}. ` +
                `EMA 200 : ${formatPrice(ema200)}. ` +
                `RSI : ${rsi.toFixed(2)}. ` +
                `ATR : ${formatPrice(atr)}. ` +
                (warnings.length ? warnings.join(" ") + " " : "") +
                "Signal indicatif : aucun gain n'est garanti."
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
                `Aucun signal H1 pour le moment. ` +
                `Tendance : ${trend}. ` +
                `EMA 50 : ${formatPrice(ema50)}. ` +
                `EMA 200 : ${formatPrice(ema200)}. ` +
                `RSI : ${rsi.toFixed(2)}. ` +
                `ATR : ${formatPrice(atr)}. ` +
                (warnings.length ? warnings.join(" ") + " " : "") +
                "Le robot attend que les conditions d'entrée soient réunies."
            );

            updateText(el.signalConf, "Conditions non réunies");
        }

        updateText(el.lastAnalysis, formatTime());

    } catch (error) {
        console.error("Erreur d'analyse :", error);

        updateText(el.trend, "Indisponible");

        clearSignal(
            `Erreur d'analyse : ${error.message || "erreur inconnue"}.`
        );

        updateText(el.lastAnalysis, formatTime());

    } finally {
        analysisRunning = false;

        if (el.refreshButton) {
            el.refreshButton.disabled = false;
        }
    }
}

// ============================================
// 15. ACTUALISATION AUTOMATIQUE DU PRIX
// ============================================

async function refreshPriceAutomatically() {
    if (priceRefreshRunning) return;

    priceRefreshRunning = true;

    try {
        await fetchPrice();

    } catch (error) {
        console.error("Erreur de mise à jour du prix :", error);

        setConnection(false, "Connexion interrompue");

    } finally {
        priceRefreshRunning = false;
    }
}

// ============================================
// 16. DÉMARRAGE DU ROBOT
// ============================================

if (el.refreshButton) {
    el.refreshButton.addEventListener("click", analyzeMarket);
}

analyzeMarket();

setInterval(
    refreshPriceAutomatically,
    PRICE_REFRESH_MS
);

setInterval(
    analyzeMarket,
    ANALYSIS_REFRESH_MS
);
        
