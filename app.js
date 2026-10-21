"use strict";

// ============================================
// 1. CONFIGURATION
// ============================================

const APP_VERSION = "XAUUSD-BIQUOTE-FIX-3";

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
const REQUEST_TIMEOUT_MS = 15000;

const CANDLE_DURATION_MS = 60 * 60 * 1000;
const MIN_CANDLES_FOR_SIGNAL = 200;

const PRICE_URLS = [
    `${API_URL}/${SYMBOL}`
];

const CANDLE_URLS = [
    `${API_URL}/${SYMBOL}/ohlc?interval=1h&limit=${CANDLE_COUNT}`,
    `${API_URL}/${SYMBOL}/ohlc?interval=1h`
];

console.log(`[${APP_VERSION}] Chargé`);

// ============================================
// 2. VARIABLES
// ============================================

let currentPrice = null;
let lastSignalKey = null;
let analysisRunning = false;
let priceRefreshRunning = false;
let historySignals = [];

// ============================================
// 3. ÉLÉMENTS HTML
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
// 4. OUTILS GÉNÉRAUX
// ============================================

function updateText(element, value) {
    if (element) {
        element.textContent = String(value);
    }
}

function formatPrice(value) {
    return Number.isFinite(value)
        ? value.toFixed(2)
        : "--";
}

function formatTime(date = new Date()) {
    return date.toLocaleTimeString("fr-FR", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
    });
}

function getNumber(value) {
    if (
        typeof value === "number" &&
        Number.isFinite(value)
    ) {
        return value;
    }

    if (
        typeof value === "string" &&
        value.trim() !== ""
    ) {
        const number = Number(value);

        return Number.isFinite(number)
            ? number
            : null;
    }

    return null;
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

// ============================================
// 5. REQUÊTES HTTP
// ============================================

async function getJSON(url) {
    const controller = new AbortController();

    const timer = setTimeout(() => {
        controller.abort();
    }, REQUEST_TIMEOUT_MS);

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
            throw new Error(`Erreur HTTP ${response.status}`);
        }

        const text = await response.text();

        let data;

        try {
            data = JSON.parse(text);
        } catch {
            throw new Error(
                `La réponse de l'API n'est pas du JSON valide. ` +
                `Début reçu : ${text.slice(0, 180)}`
            );
        }

        return data;

    } catch (error) {
        if (error.name === "AbortError") {
            throw new Error(
                "Délai de connexion dépassé après 15 secondes."
            );
        }

        if (error instanceof TypeError) {
            throw new Error(
                "Échec réseau ou accès bloqué par CORS. " +
                "Le navigateur doit être autorisé à appeler l'API."
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

            if (
                result !== null &&
                result !== undefined
            ) {
                return result;
            }

            const keys =
                data && typeof data === "object"
                    ? Object.keys(data).join(", ")
                    : typeof data;

            errors.push(
                `${url} : données reçues mais non reconnues. ` +
                `Structure : ${keys || "vide"}`
            );

            console.error(
                `[${APP_VERSION}] Réponse non reconnue`,
                url,
                data
            );

        } catch (error) {
            errors.push(`${url} : ${error.message}`);

            console.error(
                `[${APP_VERSION}] Erreur API`,
                url,
                error
            );
        }
    }

    throw new Error(
        `${label} impossible. ${errors.join(" | ")}`
    );
}

// ============================================
// 6. RÉCUPÉRATION DU PRIX
// ============================================

function parsePrice(data) {
    if (!data || typeof data !== "object") {
        return null;
    }

    if (Array.isArray(data)) {
        if (data.length === 0) return null;
        return parsePrice(data[0]);
    }

    let price = getNumber(data.mid);

    if (price === null) {
        const bid = getNumber(data.bid);
        const ask = getNumber(data.ask);

        if (
            bid !== null &&
            ask !== null &&
            bid > 0 &&
            ask > 0
        ) {
            price = (bid + ask) / 2;
        }
    }

    if (price === null) {
        price = getNumber(data.price);
    }

    if (price === null) {
        price = getNumber(data.close);
    }

    if (price === null && data.data !== undefined) {
        return parsePrice(data.data);
    }

    if (price === null && data.result !== undefined) {
        return parsePrice(data.result);
    }

    return (
        price !== null && price > 0
            ? price
            : null
    );
}

async function fetchPrice() {
    const price = await tryUrls(
        PRICE_URLS,
        parsePrice,
        "Récupération du prix XAU/USD"
    );

    currentPrice = price;

    updateText(el.price, formatPrice(price));
    updateText(el.lastUpdate, formatTime());

    return price;
}

// ============================================
// 7. NORMALISATION DES DATES
// ============================================

function parseTimeValue(value) {
    if (typeof value === "number") {
        if (!Number.isFinite(value)) {
            return null;
        }

        // Timestamp en secondes ou millisecondes.
        return value < 100000000000
            ? value * 1000
            : value;
    }

    if (
        typeof value !== "string" ||
        value.trim() === ""
    ) {
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

    return Number.isFinite(parsed)
        ? parsed
        : null;
}

// ============================================
// 8. NORMALISATION DES BOUGIES
// ============================================

function normalizeCandle(raw) {
    if (!raw || typeof raw !== "object") {
        return null;
    }

    const timeValue =
        raw.openTime ??
        raw.open_time ??
        raw.time ??
        raw.timestamp ??
        raw.datetime ??
        raw.date ??
        raw.t;

    const time = parseTimeValue(timeValue);

    if (
        time === null ||
        !Number.isFinite(time)
    ) {
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
        close === null
    ) {
        return null;
    }

    if (
        open <= 0 ||
        high <= 0 ||
        low <= 0 ||
        close <= 0
    ) {
        return null;
    }

    if (
        high < low ||
        high < open ||
        high < close ||
        low > open ||
        low > close
    ) {
        return null;
    }

    const isOpen =
        raw.isOpen === true ||
        raw.isOpen === "true" ||
        raw.is_open === true ||
        raw.is_open === "true";

    return {
        time,
        open,
        high,
        low,
        close,
        isOpen
    };
}

// ============================================
// 9. EXTRACTION DES BOUGIES BIQUOTE
// ============================================

function extractRawCandles(data, depth = 0) {
    if (depth > 5 || data == null) {
        return null;
    }

    // Certaines API renvoient directement un tableau.
    if (Array.isArray(data)) {
        return data;
    }

    if (typeof data !== "object") {
        return null;
    }

    // Format confirmé de Biquote :
    // { symbol, interval, bars: [...] }
    if (Array.isArray(data.bars)) {
        return data.bars;
    }

    // Autres formats possibles.
    if (Array.isArray(data.candles)) {
        return data.candles;
    }

    if (Array.isArray(data.ohlc)) {
        return data.ohlc;
    }

    if (Array.isArray(data.data)) {
        return data.data;
    }

    if (Array.isArray(data.result)) {
        return data.result;
    }

    // Formats enveloppés dans data, result ou payload.
    for (const key of [
        "data",
        "result",
        "payload",
        "response"
    ]) {
        if (
            data[key] &&
            typeof data[key] === "object"
        ) {
            const found = extractRawCandles(
                data[key],
                depth + 1
            );

            if (found !== null) {
                return found;
            }
        }
    }

    console.error(
        `[${APP_VERSION}] Structure de bougies inconnue`,
        data
    );

    return null;
}

// ============================================
// 10. PARSING DES BOUGIES H1
// ============================================

function parseCandles(data) {
    const rawBars = extractRawCandles(data);

    if (
        !Array.isArray(rawBars) ||
        rawBars.length === 0
    ) {
        return null;
    }

    const unique = new Map();
    let invalidCount = 0;
    let openCount = 0;
    let incompleteCount = 0;

    const now = Date.now();

    for (const raw of rawBars) {
        const candle = normalizeCandle(raw);

        if (!candle) {
            invalidCount++;
            continue;
        }

        // Ne pas utiliser une bougie encore en formation.
        if (candle.isOpen) {
            openCount++;
            continue;
        }

        // Vérification de la clôture effective de la bougie.
        // Une tolérance d'une minute absorbe de petits écarts
        // entre l'horloge du navigateur et celle du serveur.
        if (
            candle.time + CANDLE_DURATION_MS >
            now + 60 * 1000
        ) {
            incompleteCount++;
            continue;
        }

        unique.set(candle.time, candle);
    }

    const candles = Array.from(unique.values())
        .sort((a, b) => a.time - b.time);

    console.log(
        `[${APP_VERSION}] Bougies reçues : ${rawBars.length}; ` +
        `valides et clôturées : ${candles.length}; ` +
        `invalides : ${invalidCount}; ` +
        `en formation : ${openCount}; ` +
        `pas encore clôturées : ${incompleteCount}.`
    );

    if (candles.length === 0) {
        return null;
    }

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
// 11. CALCUL DE L'EMA
// ============================================

function calculateEMA(values, period) {
    if (
        !Array.isArray(values) ||
        period <= 0 ||
        values.length < period
    ) {
        return null;
    }

    let ema = values
        .slice(0, period)
        .reduce((sum, value) => sum + value, 0) /
        period;

    const multiplier = 2 / (period + 1);

    for (let i = period; i < values.length; i++) {
        ema =
            (values[i] - ema) * multiplier +
            ema;
    }

    return Number.isFinite(ema)
        ? ema
        : null;
}

// ============================================
// 12. CALCUL DU RSI — WILDER
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

    for (
        let i = period + 1;
        i < values.length;
        i++
    ) {
        const change = values[i] - values[i - 1];

        const gain = Math.max(change, 0);
        const loss = Math.max(-change, 0);

        averageGain =
            (
                averageGain * (period - 1) +
                gain
            ) / period;

        averageLoss =
            (
                averageLoss * (period - 1) +
                loss
            ) / period;
    }

    if (
        averageGain === 0 &&
        averageLoss === 0
    ) {
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
// 13. CALCUL DE L'ATR — WILDER
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
        .reduce((sum, value) => sum + value, 0) /
        period;

    for (
        let i = period;
        i < trueRanges.length;
        i++
    ) {
        atr =
            (
                atr * (period - 1) +
                trueRanges[i]
            ) / period;
    }

    return Number.isFinite(atr)
        ? atr
        : null;
}

// ============================================
// 14. AFFICHAGE DES INDICATEURS
// ============================================

function displayIndicators(
    ema50,
    ema200,
    rsi,
    atr,
    candleCount
) {
    updateText(el.ema50, formatPrice(ema50));

    let ema200Text = formatPrice(ema200);

    if (candleCount < 250) {
        ema200Text += " *";
    }

    updateText(el.ema200, ema200Text);

    updateText(
        el.rsi,
        Number.isFinite(rsi)
            ? rsi.toFixed(2)
            : "--"
    );

    updateText(el.atr, formatPrice(atr));
}

// ============================================
// 15. HISTORIQUE DES SIGNAUX
// ============================================

function addSignalToHistory(signal) {
    if (
        historySignals.some(
            item => item.key === signal.key
        )
    ) {
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
// 16. RÉINITIALISATION DU SIGNAL
// ============================================

function clearSignal(
    message = "Aucun signal pour le moment."
) {
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
// 17. ANALYSE DU MARCHÉ
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
            console.error(
                "Erreur de récupération du prix :",
                priceResult.reason
            );
        }

        if (candlesResult.status === "rejected") {
            const message =
                candlesResult.reason?.message ||
                "Erreur inconnue lors de la récupération des bougies.";

            console.error(
                `[${APP_VERSION}] Erreur bougies :`,
                candlesResult.reason
            );

            updateText(el.trend, "Indisponible");

            clearSignal(
                `Bougies H1 indisponibles. ${message}`
            );

            if (priceResult.status === "fulfilled") {
                setConnection(
                    false,
                    "Prix reçu, bougies indisponibles"
                );
            } else {
                setConnection(
                    false,
                    "Connexion API indisponible"
                );
            }

            updateText(el.lastAnalysis, formatTime());

            return;
        }

        // Les bougies sont classées de la plus ancienne
        // à la plus récente.
        const last = candles[candles.length - 1];
        const previous = candles[candles.length - 2];

        const price = currentPrice ?? last.close;

        // ----------------------------------------
        // DÉTECTION DE LA TENDANCE
        // ----------------------------------------

        let trend = "NEUTRE";

        if (
            ema50 > ema200 &&
            price > ema50
        ) {
            trend = "HAUSSIÈRE";
        } else if (
            ema50 < ema200 &&
            price < ema50
        ) {
            trend = "BAISSIÈRE";
        }

        updateText(el.trend, trend);

        // ----------------------------------------
        // CONDITIONS TECHNIQUES
        // ----------------------------------------

        const bullishCandle =
            last.close > last.open;

        const bearishCandle =
            last.close < last.open;

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

        const buySignal =
            buyTrend || touchedEMA50Up;

        const sellSignal =
            sellTrend || touchedEMA50Down;

        // ----------------------------------------
        // CALCUL DU RISQUE
        // ----------------------------------------

        let signalType = "NONE";
        let sl = null;
        let tp = null;

        const entry = price;

        if (buySignal && !sellSignal) {
            signalType = "BUY";

            sl =
                entry -
                atr * SL_ATR_MULTIPLIER;

            tp =
                entry +
                atr * TP_ATR_MULTIPLIER;

        } else if (sellSignal && !buySignal) {
            signalType = "SELL";

            sl =
                entry +
                atr * SL_ATR_MULTIPLIER;

            tp =
                entry -
                atr * TP_ATR_MULTIPLIER;
        }

        // ----------------------------------------
        // AFFICHAGE DU SIGNAL
        // ----------------------------------------

        const warnings = [];

        if (candles.length < 250) {
            warnings.push(
                `Historique de ${candles.length} bougies : ` +
                l'EMA200 peut être moins stable.'
            );
        }

        if (
            signalType === "BUY" ||
            signalType === "SELL"
        ) {
            const signalKey =
                `${signalType}-${last.time}`;

            setSignalBadge(
                signalType === "BUY"
                    ? "buy"
                    : "sell",
                signalType === "BUY"
                    ? "ACHAT"
                    : "VENTE"
            );

            updateText(
                el.signalEntry,
                formatPrice(entry)
            );

            updateText(
                el.signalSL,
                formatPrice(sl)
            );

            updateText(
                el.signalTP,
                formatPrice(tp)
            );

            updateText(el.signalRR, "1:2");

            updateText(
                el.signalConf,
                warnings.length
                    ? "Conditions réunies — prudence"
                    : "Conditions techniques réunies"
            );

            updateText(
                el.signalTime,
                formatTime()
            );

            updateText(
                el.signalReason,
                `${signalType === "BUY" ? "Signal d'achat" : "Signal de vente"} détecté sur H1. ` +
                `Tendance : ${trend}. ` +
                `EMA 50 : ${formatPrice(ema50)}. ` +
                `EMA 200 : ${formatPrice(ema200)}. ` +
                `RSI : ${rsi.toFixed(2)}. ` +
                `ATR : ${formatPrice(atr)}. ` +
                (warnings.length
                    ? warnings.join(" ") + " "
                    : "") +
                "Signal technique indicatif. Les pertes sont possibles."
            );

            if (signalKey !== lastSignalKey) {
                lastSignalKey = signalKey;

                addSignalToHistory({
                    key: signalKey,
                    type:
                        signalType === "BUY"
                            ? "ACHAT"
                            : "VENTE",
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
                "Le robot attend que les conditions techniques soient réunies."
            );

            updateText(
                el.signalConf,
                "Conditions non réunies"
            );
        }

        updateText(el.lastAnalysis, formatTime());

    } catch (error) {
        console.error(
            `[${APP_VERSION}] Erreur d'analyse :`,
            error
        );

        updateText(
            el.trend,
            "Indisponible"
        );

        clearSignal(
            `Erreur d'analyse : ${
                error.message || "erreur inconnue"
            }`
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
// 18. ACTUALISATION AUTOMATIQUE DU PRIX
// ============================================

async function refreshPriceAutomatically() {
    if (priceRefreshRunning) return;

    priceRefreshRunning = true;

    try {
        await fetchPrice();

        if (!analysisRunning) {
            setConnection(true, "Données reçues");
        }

    } catch (error) {
        console.error(
            "Erreur d'actualisation du prix :",
            error
        );

        setConnection(
            false,
            "Erreur de mise à jour du prix"
        );

    } finally {
        priceRefreshRunning = false;
    }
}

// ============================================
// 19. DÉMARRAGE DU ROBOT
// ============================================

if (el.refreshButton) {
    el.refreshButton.addEventListener(
        "click",
        analyzeMarket
    );
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
        }

  
