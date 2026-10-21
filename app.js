"use strict";

// ============================================
// 1. CONFIGURATION
// ============================================

const API_URL = "https://biquote.io/api";
const SYMBOL = "XAUUSD";

const TIMEFRAME = "4h";
const CANDLE_COUNT = 500;

const EMA_FAST = 50;
const EMA_SLOW = 200;
const RSI_PERIOD = 14;
const ATR_PERIOD = 14;

const SL_ATR_MULTIPLIER = 1.5;
const TP_ATR_MULTIPLIER = 3;

const PRICE_REFRESH_MS = 15000;
const ANALYSIS_REFRESH_MS = 60000;

// Il faut idéalement plus de 200 bougies pour stabiliser l'EMA 200.
const MIN_CANDLES_FOR_SIGNAL = 250;

// ============================================
// 2. VARIABLES
// ============================================

let currentPrice = null;
let candles = [];
let lastSignalKey = "";
let isAnalyzing = false;
let analysisTimer = null;
let priceTimer = null;

// ============================================
// 3. AFFICHAGE
// ============================================

function getElement(id) {
    return document.getElementById(id);
}

function setText(id, value) {
    const element = getElement(id);

    if (element) {
        element.textContent = value;
    }
}

function formatPrice(value) {
    return Number.isFinite(value) ? value.toFixed(2) : "--";
}

function setStatus(message, connected = false) {
    const element = getElement("connection-status");

    if (!element) return;

    element.textContent = message;
    element.style.color = connected ? "#22c55e" : "#f59e0b";
}

function resetSignalDisplay(type = "PAS DE SIGNAL") {
    setText("signal-type", type);
    setText("signal-entry", "--");
    setText("signal-sl", "--");
    setText("signal-tp", "--");
    setText("signal-rr", "--");
    setText("signal-conf", "--");
    setText("signal-time", "--");

    const element = getElement("signal-type");

    if (element) {
        element.style.color = "#f59e0b";
    }
}

// ============================================
// 4. PRIX EN TEMPS RÉEL
// ============================================

async function fetchPrice() {
    const response = await fetch(
        `${API_URL}/${SYMBOL}?allowStale=false`,
        { cache: "no-store" }
    );

    if (!response.ok) {
        throw new Error(`Erreur prix HTTP ${response.status}`);
    }

    const data = await response.json();

    const price = Number(data.mid);

    if (!Number.isFinite(price) || price <= 0) {
        throw new Error("Prix XAU/USD invalide.");
    }

    if (data.stale === true) {
        throw new Error("Le prix reçu est ancien.");
    }

    currentPrice = price;

    setText("current-price", formatPrice(price));
    setText("last-update", new Date().toLocaleTimeString("fr-FR"));

    return price;
}

// ============================================
// 5. HISTORIQUE DES BOUGIES H4
// ============================================

async function fetchCandles() {
    const url =
        `${API_URL}/${SYMBOL}/ohlc` +
        `?interval=${TIMEFRAME}&limit=${CANDLE_COUNT}`;

    const response = await fetch(url, {
        cache: "no-store"
    });

    if (!response.ok) {
        throw new Error(`Erreur bougies HTTP ${response.status}`);
    }

    const data = await response.json();

    if (!Array.isArray(data.bars)) {
        throw new Error("Biquote n'a pas fourni de bougies.");
    }

    const now = Date.now();

    const parsed = data.bars
        .filter(candle => {
            const open = Number(candle.open);
            const high = Number(candle.high);
            const low = Number(candle.low);
            const close = Number(candle.close);
            const time = Date.parse(candle.openTime);

            return (
                Number.isFinite(open) &&
                Number.isFinite(high) &&
                Number.isFinite(low) &&
                Number.isFinite(close) &&
                open > 0 &&
                high >= low &&
                low > 0 &&
                close > 0 &&
                Number.isFinite(time) &&
                candle.isOpen !== true &&
                time + 4 * 60 * 60 * 1000 <= now
            );
        })
        .map(candle => ({
            time: candle.openTime,
            timestamp: Date.parse(candle.openTime),
            open: Number(candle.open),
            high: Number(candle.high),
            low: Number(candle.low),
            close: Number(candle.close)
        }))
        .sort((a, b) => a.timestamp - b.timestamp);

    // Supprimer les doublons.
    candles = parsed.filter((candle, index, array) => {
        return index === 0 ||
            candle.timestamp !== array[index - 1].timestamp;
    });

    console.log("Bougies demandées :", CANDLE_COUNT);
    console.log("Bougies reçues par Biquote :", data.bars.length);
    console.log("Bougies clôturées valides :", candles.length);

    return candles;
}

// ============================================
// 6. EMA — MOYENNE MOBILE EXPONENTIELLE
// ============================================

function calculateEMA(values, period) {
    if (values.length < period) {
        return null;
    }

    const multiplier = 2 / (period + 1);

    // Initialisation par la moyenne simple des premières valeurs.
    let sum = 0;

    for (let i = 0; i < period; i++) {
        sum += values[i];
    }

    let ema = sum / period;

    for (let i = period; i < values.length; i++) {
        ema = values[i] * multiplier + ema * (1 - multiplier);
    }

    return ema;
}

// ============================================
// 7. RSI — MÉTHODE DE WILDER
// ============================================

function calculateRSI(values, period = 14) {
    if (values.length <= period) {
        return null;
    }

    let gainSum = 0;
    let lossSum = 0;

    for (let i = 1; i <= period; i++) {
        const change = values[i] - values[i - 1];

        if (change > 0) {
            gainSum += change;
        } else {
            lossSum += Math.abs(change);
        }
    }

    let averageGain = gainSum / period;
    let averageLoss = lossSum / period;

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

    const rs = averageGain / averageLoss;

    return 100 - 100 / (1 + rs);
}

// ============================================
// 8. ATR — VOLATILITÉ
// ============================================

function calculateATR(data, period = 14) {
    if (data.length <= period) {
        return null;
    }

    const ranges = [];

    for (let i = 1; i < data.length; i++) {
        const current = data[i];
        const previous = data[i - 1];

        ranges.push(Math.max(
            current.high - current.low,
            Math.abs(current.high - previous.close),
            Math.abs(current.low - previous.close)
        ));
    }

    let atr = 0;

    for (let i = 0; i < period; i++) {
        atr += ranges[i];
    }

    atr /= period;

    // Lissage de Wilder.
    for (let i = period; i < ranges.length; i++) {
        atr = (atr * (period - 1) + ranges[i]) / period;
    }

    return atr;
}

// ============================================
// 9. AFFICHAGE DES INDICATEURS
// ============================================

function displayIndicators(ema50, ema200, rsi, atr) {
    setText("ema50", formatPrice(ema50));
    setText("ema200", formatPrice(ema200));

    setText("rsi", Number.isFinite(rsi) ? rsi.toFixed(2) : "--");
    setText("atr", formatPrice(atr));
}

// ============================================
// 10. TENDANCE
// ============================================

function displayTrend(ema50, ema200, close) {
    let trend = "NEUTRE";

    if (ema50 > ema200 && close > ema50) {
        trend = "HAUSSE";
    } else if (ema50 < ema200 && close < ema50) {
        trend = "BAISSE";
    }

    setText("market-tendance", trend);

    return trend;
}

// ============================================
// 11. HISTORIQUE DES SIGNAUX
// ============================================

function saveSignal(type, entry, sl, tp, rsi) {
    const table = getElement("history-table");

    if (!table) return;

    const row = document.createElement("tr");

    const values = [
        new Date().toLocaleString("fr-FR"),
        type,
        formatPrice(entry),
        `${formatPrice(sl)} / ${formatPrice(tp)}`,
        `RSI ${rsi.toFixed(2)}`
    ];

    values.forEach(value => {
        const cell = document.createElement("td");
        cell.textContent = value;
        row.appendChild(cell);
    });

    table.prepend(row);

    while (table.children.length > 30) {
        table.removeChild(table.lastElementChild);
    }
}

// ============================================
// 12. AFFICHER UN SIGNAL
// ============================================

function displaySignal(type, entry, sl, tp, reason, rsi) {
    setText("signal-type", type);
    setText("signal-entry", formatPrice(entry));
    setText("signal-sl", formatPrice(sl));
    setText("signal-tp", formatPrice(tp));
    setText("signal-rr", "1:2");
    setText("signal-conf", "Conditions techniques réunies");
    setText("signal-reason", reason);
    setText("signal-time", new Date().toLocaleString("fr-FR"));

    const element = getElement("signal-type");

    if (element) {
        element.style.color =
            type === "ACHAT" ? "#22c55e" : "#ef4444";
    }

    const latest = candles[candles.length - 1];

    const key = `${type}-${latest.time}`;

    if (key !== lastSignalKey) {
        saveSignal(type, entry, sl, tp, rsi);
        lastSignalKey = key;
    }
}

// ============================================
// 13. ANALYSE AUTOMATIQUE H4
// ============================================

async function analyzeMarket() {
    if (isAnalyzing) return;

    isAnalyzing = true;

    try {
        setText("last-analysis", "Analyse en cours...");
        setStatus("Récupération des données...", false);

        // Prix et bougies sont récupérés séparément.
        const pricePromise = fetchPrice();
        const candlesPromise = fetchCandles();

        const results = await Promise.allSettled([
            pricePromise,
            candlesPromise
        ]);

        const priceResult = results[0];
        const candlesResult = results[1];

        if (priceResult.status === "rejected") {
            console.error("Prix :", priceResult.reason);
        }

        if (candlesResult.status === "rejected") {
            throw candlesResult.reason;
        }

        if (candles.length < EMA_SLOW) {
            resetSignalDisplay("HISTORIQUE INSUFFISANT");

            setText(
                "signal-reason",
                `Biquote fournit ${candles.length} bougies H4 clôturées. Il faut au moins 200 pour calculer l'EMA 200. Idéalement, utilisez 300 à 500 bougies.`
            );

            setText("last-analysis", "Historique insuffisant");
            setStatus("Données reçues, historique insuffisant", false);

            return;
        }

        const closes = candles.map(candle => candle.close);

        const ema50 = calculateEMA(closes, EMA_FAST);
        const ema200 = calculateEMA(closes, EMA_SLOW);
        const rsi = calculateRSI(closes, RSI_PERIOD);
        const atr = calculateATR(candles, ATR_PERIOD);

        const lastCandle = candles[candles.length - 1];
        const previousCandle = candles[candles.length - 2];

        const close = lastCandle.close;

        displayIndicators(ema50, ema200, rsi, atr);

        const trend = displayTrend(ema50, ema200, close);

        if (
            !Number.isFinite(ema50) ||
            !Number.isFinite(ema200) ||
            !Number.isFinite(rsi) ||
            !Number.isFinite(atr) ||
            atr <= 0
        ) {
            resetSignalDisplay("EN ATTENTE");
            setText("signal-reason", "Les indicateurs ne peuvent pas être calculés.");
            setText("last-analysis", "Analyse incomplète");
            setStatus("Analyse incomplète", false);
            return;
        }

        // Une tendance doit être confirmée par les moyennes
        // et par la clôture de la dernière bougie H4.
        const bullishTrend =
            ema50 > ema200 &&
            close > ema50;

        const bearishTrend =
            ema50 < ema200 &&
            close < ema50;

        // Confirmation simple par la bougie clôturée.
        const bullishCandle = lastCandle.close > lastCandle.open;
        const bearishCandle = lastCandle.close < lastCandle.open;

        // Évite d'acheter une situation très surachetée
        // ou de vendre une situation très survendue.
        const buyMomentum = rsi >= 50 && rsi <= 68;
        const sellMomentum = rsi >= 32 && rsi <= 50;

        let type = null;
        let reason = "";

        if (
            bullishTrend &&
            buyMomentum &&
            bullishCandle &&
            lastCandle.close > previousCandle.close
        ) {
            type = "ACHAT";

            reason =
                "Tendance haussière confirmée par EMA 50/200, RSI favorable et bougie H4 haussière.";
        } else if (
            bearishTrend &&
            sellMomentum &&
            bearishCandle &&
            lastCandle.close < previousCandle.close
        ) {
            type = "VENTE";

            reason =
                "Tendance baissière confirmée par EMA 50/200, RSI favorable et bougie H4 baissière.";
        }

        if (candles.length < MIN_CANDLES_FOR_SIGNAL) {
            reason +=
                ` Attention : ${candles.length} bougies disponibles. Une EMA 200 plus stable nécessite davantage d'historique.`;
        }

        if (!type) {
            resetSignalDisplay("PAS DE SIGNAL");

            setText(
                "signal-reason",
                `Aucune configuration confirmée. Tendance : ${trend}. RSI : ${rsi.toFixed(2)}. Le robot attend une confirmation.`
            );

            setText("last-analysis", "Analyse terminée");
            setStatus("Connecté — analyse effectuée", true);

            return;
        }

        // Le prix actuel est utilisé pour estimer l'entrée.
        // Il ne garantit pas le prix d'exécution.
        const entry = currentPrice || close;

        let sl;
        let tp;

        if (type === "ACHAT") {
            sl = entry - atr * SL_ATR_MULTIPLIER;
            tp = entry + atr * TP_ATR_MULTIPLIER;
        } else {
            sl = entry + atr * SL_ATR_MULTIPLIER;
            tp = entry - atr * TP_ATR_MULTIPLIER;
        }

        displaySignal(type, entry, sl, tp, reason, rsi);

        setText("last-analysis", "Analyse terminée");
        setStatus("Connecté — analyse effectuée", true);

    } catch (error) {
        console.error("Erreur d'analyse :", error);

        resetSignalDisplay("ERREUR");

        setText(
            "signal-reason",
            error?.message ||
            "Impossible de récupérer les données de Biquote."
        );

        setText("last-analysis", "Erreur d'analyse");
        setStatus("Erreur de récupération des données", false);

    } finally {
        isAnalyzing = false;
    }
}

// ============================================
// 14. ACTUALISATION AUTOMATIQUE
// ============================================

function startAutomaticAnalysis() {
    if (analysisTimer) clearInterval(analysisTimer);
    if (priceTimer) clearInterval(priceTimer);

    analyzeMarket();

    // Actualisation du prix toutes les 15 secondes.
    priceTimer = setInterval(async () => {
        try {
            await fetchPrice();
        } catch (error) {
            console.error("Actualisation du prix :", error);
            setStatus("Erreur de récupération du prix", false);
        }
    }, PRICE_REFRESH_MS);

    // Nouvelle analyse toutes les 60 secondes.
    // Les indicateurs H4 ne changent réellement qu'à la
    // clôture d'une nouvelle bougie H4.
    analysisTimer = setInterval(() => {
        analyzeMarket();
    }, ANALYSIS_REFRESH_MS);
}

// ============================================
// 15. INITIALISATION
// ============================================

function initializeApp() {
    const refreshButton = getElement("refresh-button");

    if (refreshButton) {
        refreshButton.addEventListener("click", () => {
            analyzeMarket();
        });
    }

    startAutomaticAnalysis();
}

// ============================================
// 16. DÉMARRAGE
// ============================================

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeApp);
} else {
    initializeApp();
}
