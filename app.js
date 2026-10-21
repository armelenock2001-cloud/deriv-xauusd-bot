"use strict";

// ============================================
// 1. CONFIGURATION BIQUOTE — XAUUSD H4
// ============================================

const API_URL = "https://biquote.io/api";
const SYMBOL = "XAUUSD";

const TIMEFRAME = "4h";
const CANDLE_COUNT = 300;

const EMA_FAST = 50;
const EMA_SLOW = 200;
const RSI_PERIOD = 14;
const ATR_PERIOD = 14;

const SL_ATR_MULTIPLIER = 1.5;
const TP_ATR_MULTIPLIER = 3;

const PRICE_REFRESH_MS = 15000;
const CANDLES_REFRESH_MS = 60000;

let candles = [];
let currentPrice = null;
let lastSignalType = null;
let priceTimer = null;
let candlesTimer = null;
let isLoadingCandles = false;

// ============================================
// 2. AFFICHAGE ET STATUT
// ============================================

function setText(id, value) {
    const element = document.getElementById(id);
    if (element) element.textContent = value;
}

function setStatus(message, connected = false) {
    const element = document.getElementById("connection-status");

    if (element) {
        element.textContent = message;
        element.className = connected
            ? "status connected"
            : "status disconnected";
    }

    console.log("[BIQUOTE]", message);
}

function formatPrice(value) {
    return Number(value).toFixed(2);
}

function formatTime(date = new Date()) {
    return date.toLocaleTimeString();
}

// ============================================
// 3. RÉCUPÉRER LE PRIX EN TEMPS RÉEL
// ============================================

async function fetchPrice() {
    try {
        const response = await fetch(
            `${API_URL}/${SYMBOL}?allowStale=false`,
            { cache: "no-store" }
        );

        if (!response.ok) {
            throw new Error(`Erreur HTTP ${response.status}`);
        }

        const data = await response.json();

        if (typeof data.mid !== "number" || data.stale === true) {
            throw new Error("Prix indisponible ou périmé.");
        }

        currentPrice = data.mid;

        setText("current-price", formatPrice(currentPrice));

        const quoteTime = data.timestamp
            ? new Date(data.timestamp)
            : new Date();

        setText("last-update", formatTime(quoteTime));

        setStatus("Connecté à Biquote — XAUUSD H4", true);

        return data;

    } catch (error) {
        console.error("Erreur récupération prix :", error);

        setStatus("Erreur prix : " + error.message);

        return null;
    }
}

// ============================================
// 4. RÉCUPÉRER LES BOUGIES H4
// ============================================

async function fetchCandles() {
    if (isLoadingCandles) return;

    isLoadingCandles = true;

    try {
        const response = await fetch(
            `${API_URL}/${SYMBOL}/ohlc?interval=${TIMEFRAME}&limit=${CANDLE_COUNT}`,
            { cache: "no-store" }
        );

        if (!response.ok) {
            throw new Error(`Erreur HTTP ${response.status}`);
        }

        const data = await response.json();

        if (!Array.isArray(data.bars) || data.bars.length === 0) {
            throw new Error("Aucune bougie H4 reçue.");
        }

        const now = Date.now();
        const fourHours = 4 * 60 * 60 * 1000;

        candles = data.bars
            .filter(c => {
                return (
                    Number.isFinite(Number(c.open)) &&
                    Number.isFinite(Number(c.high)) &&
                    Number.isFinite(Number(c.low)) &&
                    Number.isFinite(Number(c.close)) &&
                    c.openTime
                );
            })
            .map(c => ({
                time: new Date(c.openTime).getTime(),
                open: Number(c.open),
                high: Number(c.high),
                low: Number(c.low),
                close: Number(c.close),
                isOpen: c.isOpen === true
            }))
            .filter(c => {
                // Utiliser uniquement les bougies H4 clôturées.
                return (
                    !c.isOpen &&
                    Number.isFinite(c.time) &&
                    c.time + fourHours <= now
                );
            })
            .sort((a, b) => a.time - b.time);

        if (candles.length < EMA_SLOW) {
            throw new Error(
                `Historique insuffisant : ${candles.length} bougies clôturées.`
            );
        }

        setText("last-analysis", formatTime());

        console.log(
            `${candles.length} bougies H4 clôturées récupérées.`
        );

        analyzeMarket();

    } catch (error) {
        console.error("Erreur récupération bougies :", error);

        setStatus("Erreur bougies H4 : " + error.message);

    } finally {
        isLoadingCandles = false;
    }
}

// ============================================
// 5. CALCUL EMA
// ============================================

function calculateEMA(values, period) {
    if (values.length < period) return [];

    const result = [];
    const multiplier = 2 / (period + 1);

    let sum = 0;

    for (let i = 0; i < period; i++) {
        sum += values[i];
    }

    let ema = sum / period;

    result[period - 1] = ema;

    for (let i = period; i < values.length; i++) {
        ema = (values[i] - ema) * multiplier + ema;
        result[i] = ema;
    }

    return result;
}

// ============================================
// 6. CALCUL RSI
// ============================================

function calculateRSI(values, period = 14) {
    if (values.length <= period) return null;

    let gains = 0;
    let losses = 0;

    for (let i = 1; i <= period; i++) {
        const change = values[i] - values[i - 1];

        if (change > 0) gains += change;
        else losses -= change;
    }

    let averageGain = gains / period;
    let averageLoss = losses / period;

    let rsi = averageLoss === 0
        ? 100
        : 100 - 100 / (1 + averageGain / averageLoss);

    for (let i = period + 1; i < values.length; i++) {
        const change = values[i] - values[i - 1];

        const gain = Math.max(change, 0);
        const loss = Math.max(-change, 0);

        averageGain =
            (averageGain * (period - 1) + gain) / period;

        averageLoss =
            (averageLoss * (period - 1) + loss) / period;

        rsi = averageLoss === 0
            ? 100
            : 100 - 100 / (1 + averageGain / averageLoss);
    }

    return rsi;
}

// ============================================
// 7. CALCUL ATR
// ============================================

function calculateATR(data, period = 14) {
    if (data.length <= period) return null;

    const trueRanges = [];

    for (let i = 1; i < data.length; i++) {
        const candle = data[i];
        const previousClose = data[i - 1].close;

        const trueRange = Math.max(
            candle.high - candle.low,
            Math.abs(candle.high - previousClose),
            Math.abs(candle.low - previousClose)
        );

        trueRanges.push(trueRange);
    }

    if (trueRanges.length < period) return null;

    let atr = 0;

    for (let i = 0; i < period; i++) {
        atr += trueRanges[i];
    }

    atr /= period;

    for (let i = period; i < trueRanges.length; i++) {
        atr = (atr * (period - 1) + trueRanges[i]) / period;
    }

    return atr;
}

// ============================================
// 8. ANALYSE DU MARCHÉ H4
// ============================================

function analyzeMarket() {
    if (candles.length < EMA_SLOW + 5) {
        setText("signal-reason", "Chargement de l'historique H4...");
        return;
    }

    const closes = candles.map(c => c.close);

    const ema50Values = calculateEMA(closes, EMA_FAST);
    const ema200Values = calculateEMA(closes, EMA_SLOW);

    const ema50 = ema50Values[ema50Values.length - 1];
    const ema200 = ema200Values[ema200Values.length - 1];

    const rsi = calculateRSI(closes, RSI_PERIOD);
    const atr = calculateATR(candles, ATR_PERIOD);

    const lastCandle = candles[candles.length - 1];
    const close = lastCandle.close;

    if (
        !Number.isFinite(ema50) ||
        !Number.isFinite(ema200) ||
        !Number.isFinite(rsi) ||
        !Number.isFinite(atr) ||
        atr <= 0
    ) {
        setText("signal-reason", "Indicateurs en cours de calcul.");
        return;
    }

    setText("ema50", formatPrice(ema50));
    setText("ema200", formatPrice(ema200));
    setText("rsi", rsi.toFixed(2));
    setText("atr", formatPrice(atr));

    let tendance = "Neutre";

    if (ema50 > ema200 && close > ema50) {
        tendance = "Haussière";
    } else if (ema50 < ema200 && close < ema50) {
        tendance = "Baissière";
    }

    setText("market-tendance", tendance);

    const tendanceElement =
        document.getElementById("market-tendance");

    if (tendanceElement) {
        tendanceElement.style.color =
            tendance === "Haussière"
                ? "#27ae60"
                : tendance === "Baissière"
                    ? "#c0392b"
                    : "#f39c12";
    }

    // Conditions volontairement strictes :
    // BUY : tendance haussière et RSI entre 50 et 70.
    // SELL : tendance baissière et RSI entre 30 et 50.

    let type = null;
    let reason = "";

    if (
        ema50 > ema200 &&
        close > ema50 &&
        rsi > 50 &&
        rsi < 70
    ) {
        type = "BUY";
        reason = "Tendance H4 haussière, EMA50 > EMA200 et RSI favorable.";
    } else if (
        ema50 < ema200 &&
        close < ema50 &&
        rsi < 50 &&
        rsi > 30
    ) {
        type = "SELL";
        reason = "Tendance H4 baissière, EMA50 < EMA200 et RSI favorable.";
    } else {
        reason = "Pas de signal H4 : les conditions ne sont pas toutes réunies.";
    }

    setText("signal-reason", reason);

    if (!type) {
        setText("signal-conf", "--");
        return;
    }

    // Le prix affiché est le prix courant de Biquote.
    const entry = currentPrice ?? close;

    const sl = type === "BUY"
        ? entry - atr * SL_ATR_MULTIPLIER
        : entry + atr * SL_ATR_MULTIPLIER;

    const tp = type === "BUY"
        ? entry + atr * TP_ATR_MULTIPLIER
        : entry - atr * TP_ATR_MULTIPLIER;

    // Ne pas présenter un même signal à chaque actualisation.
    const signalKey = `${type}-${lastCandle.time}`;

    if (signalKey !== lastSignalType) {
        lastSignalType = signalKey;

        triggerSignal(
            type,
            entry,
            sl,
            tp,
            tendance,
            reason,
            signalKey
        );
    }
}

// ============================================
// 9. AFFICHER UN SIGNAL
// ============================================

function triggerSignal(
    type,
    entry,
    sl,
    tp,
    tendance,
    reason,
    signalKey
) {
    const time = formatTime();

    const badge = document.getElementById("signal-type");

    if (badge) {
        badge.textContent = type;
        badge.className = `badge ${type.toLowerCase()}`;
    }

    setText("signal-entry", formatPrice(entry));
    setText("signal-sl", formatPrice(sl));
    setText("signal-tp", formatPrice(tp));
    setText("signal-rr", "1:2");
    setText("signal-conf", "Conditions techniques réunies");
    setText("signal-reason", reason);
    setText("signal-time", time);

    const tbody = document.querySelector("#history-table tbody");

    if (tbody) {
        const row = document.createElement("tr");

        const cells = [
            time,
            type,
            formatPrice(entry),
            `SL: ${formatPrice(sl)} / TP: ${formatPrice(tp)}`,
            tendance
        ];

        cells.forEach((value, index) => {
            const td = document.createElement("td");

            if (index === 1) {
                const span = document.createElement("span");
                span.className = `badge ${type.toLowerCase()}`;
                span.textContent = value;
                td.appendChild(span);
            } else {
                td.textContent = value;
            }

            row.appendChild(td);
        });

        tbody.prepend(row);
    }

    console.log("Nouveau signal H4 :", {
        type,
        entry,
        sl,
        tp,
        tendance,
        signalKey
    });
}

// ============================================
// 10. ACTUALISATION MANUELLE
// ============================================

async function refreshAnalysis() {
    setStatus("Actualisation des données...");

    await fetchPrice();
    await fetchCandles();
}

// Compatible avec un bouton HTML existant.
const refreshButton = document.getElementById("refresh-button");

if (refreshButton) {
    refreshButton.addEventListener("click", refreshAnalysis);
}

// ============================================
// 11. DÉMARRAGE AUTOMATIQUE
// ============================================

async function startApp() {
    setStatus("Connexion à Biquote...");

    await Promise.all([
        fetchPrice(),
        fetchCandles()
    ]);

    // Prix actualisé toutes les 15 secondes.
    priceTimer = setInterval(fetchPrice, PRICE_REFRESH_MS);

    // Bougies H4 et analyse actualisées toutes les minutes.
    candlesTimer = setInterval(async () => {
        await fetchPrice();
        await fetchCandles();
    }, CANDLES_REFRESH_MS);
}

window.addEventListener("load", startApp);

window.addEventListener("beforeunload", () => {
    clearInterval(priceTimer);
    clearInterval(candlesTimer);
});
