"use strict";

// ============================================
// 1. CONFIGURATION
// ============================================

const API_URL = "https://biquote.io/api";
const SYMBOL = "XAUUSD";

const TIMEFRAME = 14400; // H4 = 4 heures
const CANDLE_COUNT = 300;

const EMA_FAST = 50;
const EMA_SLOW = 200;
const RSI_PERIOD = 14;
const ATR_PERIOD = 14;

const SL_ATR_MULTIPLIER = 1.5;
const REWARD_RISK_RATIO = 2;

const PRICE_REFRESH_MS = 15000;
const CANDLE_REFRESH_MS = 60000;

// ============================================
// 2. VARIABLES
// ============================================

let refreshTimer = null;
let priceTimer = null;

let requestInProgress = false;
let priceRequestInProgress = false;

let candles = [];
let currentPrice = null;

let lastProcessedCandle = null;
let lastSignalKey = null;

let stopped = false;

// ============================================
// 3. OUTILS
// ============================================

function el(id) {
    return document.getElementById(id);
}

function setText(id, value) {
    const node = el(id);

    if (node) {
        node.textContent = value;
    }
}

function logStatus(message, connected = false) {
    setText("connection-status", message);

    const node = el("connection-status");

    if (node) {
        node.className =
            "status " + (connected ? "connected" : "disconnected");
    }

    console.log("[XAU/USD]", message);
}

function formatPrice(value) {
    return Number.isFinite(value)
        ? value.toFixed(2)
        : "--";
}

function formatTime(epoch) {
    return new Date(epoch * 1000).toLocaleString("fr-FR");
}

function isValidNumber(value) {
    return Number.isFinite(Number(value));
}

// ============================================
// 4. RÉCUPÉRATION DU PRIX EN TEMPS RÉEL
// ============================================

async function fetchPrice() {
    if (priceRequestInProgress || stopped) {
        return;
    }

    priceRequestInProgress = true;

    try {
        const response = await fetch(
            API_URL + "/" + SYMBOL + "?allowStale=false",
            { cache: "no-store" }
        );

        if (!response.ok) {
            throw new Error(
                "Erreur HTTP " + response.status +
                " lors de la récupération du prix."
            );
        }

        const data = await response.json();

        const price = Number(data.mid);

        if (!Number.isFinite(price) || price <= 0) {
            throw new Error("Prix XAUUSD invalide.");
        }

        // Vérifier si le prix est réellement récent.
        const quoteTime = Date.parse(data.timestamp);
        const ageSeconds = Number(data.quoteAgeSeconds);

        if (
            Number.isFinite(ageSeconds) &&
            ageSeconds > 300
        ) {
            throw new Error(
                "Cotations trop anciennes : " +
                ageSeconds + " secondes."
            );
        }

        if (
            Number.isFinite(quoteTime) &&
            Date.now() - quoteTime > 300000
        ) {
            throw new Error(
                "La dernière cotation date de plus de 5 minutes."
            );
        }

        currentPrice = price;

        setText("current-price", formatPrice(currentPrice));

        if (Number.isFinite(quoteTime)) {
            setText(
                "last-update",
                new Date(quoteTime).toLocaleTimeString("fr-FR")
            );
        }

        console.log(
            "[BIQUOTE] XAUUSD :",
            currentPrice,
            "| Source :",
            data.source || "non précisée"
        );

        if (candles.length > 0) {
            logStatus(
                "Biquote connecté — prix actualisé",
                true
            );
        } else {
            logStatus(
                "Prix reçu — chargement de l'historique H4",
                true
            );
        }

    } catch (error) {
        console.error("Erreur prix Biquote :", error);

        logStatus(
            "Prix indisponible : " + error.message
        );

    } finally {
        priceRequestInProgress = false;
    }
}

// ============================================
// 5. RÉCUPÉRATION DES BOUGIES H4
// ============================================

async function requestCandles() {
    if (requestInProgress || stopped) {
        return;
    }

    requestInProgress = true;

    try {
        const url =
            API_URL + "/" + SYMBOL +
            "/ohlc?interval=4h&limit=" + CANDLE_COUNT;

        const response = await fetch(url, {
            cache: "no-store"
        });

        if (!response.ok) {
            throw new Error(
                "Erreur HTTP " + response.status +
                " pendant le chargement des bougies."
            );
        }

        const data = await response.json();

        if (!data || !Array.isArray(data.bars)) {
            throw new Error(
                "Format de réponse OHLC non reconnu."
            );
        }

        const receivedCandles = data.bars
            .map(function (c) {
                return {
                    epoch: Math.floor(
                        Date.parse(c.openTime) / 1000
                    ),

                    open: Number(c.open),
                    high: Number(c.high),
                    low: Number(c.low),
                    close: Number(c.close),

                    isOpen: c.isOpen === true
                };
            })
            .filter(function (c) {
                return (
                    Number.isFinite(c.epoch) &&
                    [
                        c.open,
                        c.high,
                        c.low,
                        c.close
                    ].every(Number.isFinite) &&
                    c.high >= c.low
                );
            })
            .sort(function (a, b) {
                return a.epoch - b.epoch;
            });

        if (receivedCandles.length === 0) {
            throw new Error(
                "Aucune bougie H4 valide reçue."
            );
        }

        candles = receivedCandles;

        console.log(
            "[BIQUOTE] Bougies reçues :",
            candles.length
        );

        console.log(
            "[BIQUOTE] Dernière bougie :",
            candles[candles.length - 1]
        );

        analyzeMarket();

        logStatus(
            "Biquote connecté — analyse H4 actualisée",
            true
        );

    } catch (error) {
        console.error("Erreur historique Biquote :", error);

        logStatus(
            "Erreur historique : " + error.message
        );

        setText(
            "signal-reason",
            "Impossible de charger les bougies H4. " +
            error.message
        );

    } finally {
        requestInProgress = false;
    }
}

// ============================================
// 6. EMA
// ============================================

function calculateEMA(values, period) {
    const result = new Array(values.length).fill(null);

    if (values.length < period) {
        return result;
    }

    let sum = 0;

    for (let i = 0; i < period; i++) {
        sum += values[i];
    }

    let ema = sum / period;

    result[period - 1] = ema;

    const multiplier = 2 / (period + 1);

    for (let i = period; i < values.length; i++) {
        ema =
            (values[i] - ema) * multiplier + ema;

        result[i] = ema;
    }

    return result;
}

// ============================================
// 7. RSI
// ============================================

function calculateRSI(values, period = 14) {
    const result = new Array(values.length).fill(null);

    if (values.length <= period) {
        return result;
    }

    let gains = 0;
    let losses = 0;

    for (let i = 1; i <= period; i++) {
        const difference =
            values[i] - values[i - 1];

        gains += Math.max(difference, 0);
        losses += Math.max(-difference, 0);
    }

    let averageGain = gains / period;
    let averageLoss = losses / period;

    function getRSI(gain, loss) {
        if (gain === 0 && loss === 0) {
            return 50;
        }

        if (loss === 0) {
            return 100;
        }

        return 100 - 100 / (1 + gain / loss);
    }

    result[period] = getRSI(
        averageGain,
        averageLoss
    );

    for (
        let i = period + 1;
        i < values.length;
        i++
    ) {
        const difference =
            values[i] - values[i - 1];

        averageGain = (
            averageGain * (period - 1) +
            Math.max(difference, 0)
        ) / period;

        averageLoss = (
            averageLoss * (period - 1) +
            Math.max(-difference, 0)
        ) / period;

        result[i] = getRSI(
            averageGain,
            averageLoss
        );
    }

    return result;
}

// ============================================
// 8. ATR
// ============================================

function calculateATR(data, period = 14) {
    const result = new Array(data.length).fill(null);

    if (data.length <= period) {
        return result;
    }

    const ranges = [];

    for (let i = 0; i < data.length; i++) {
        if (i === 0) {
            ranges.push(
                data[i].high - data[i].low
            );

            continue;
        }

        const previousClose = data[i - 1].close;

        ranges.push(
            Math.max(
                data[i].high - data[i].low,
                Math.abs(
                    data[i].high - previousClose
                ),
                Math.abs(
                    data[i].low - previousClose
                )
            )
        );
    }

    let average = 0;

    for (let i = 1; i <= period; i++) {
        average += ranges[i];
    }

    average /= period;

    result[period] = average;

    for (
        let i = period + 1;
        i < data.length;
        i++
    ) {
        average = (
            average * (period - 1) +
            ranges[i]
        ) / period;

        result[i] = average;
    }

    return result;
}

// ============================================
// 9. ANALYSE DU MARCHÉ H4
// ============================================

function analyzeMarket() {
    if (candles.length < EMA_SLOW + 5) {
        setText(
            "signal-reason",
            "Historique insuffisant : " +
            candles.length +
            " bougies reçues. " +
            "Il en faut au moins 205."
        );

        return;
    }

    const now = Math.floor(Date.now() / 1000);

    // Ne garder que les bougies clôturées.
    const closedCandles = candles.filter(
        function (c) {
            return (
                !c.isOpen &&
                c.epoch + TIMEFRAME <= now
            );
        }
    );

    if (closedCandles.length < EMA_SLOW + 5) {
        setText(
            "signal-reason",
            "En attente d'au moins 205 bougies H4 clôturées. " +
            "Disponibles : " + closedCandles.length
        );

        return;
    }

    const closes = closedCandles.map(
        function (c) {
            return c.close;
        }
    );

    const ema50 = calculateEMA(
        closes,
        EMA_FAST
    );

    const ema200 = calculateEMA(
        closes,
        EMA_SLOW
    );

    const rsi = calculateRSI(
        closes,
        RSI_PERIOD
    );

    const atr = calculateATR(
        closedCandles,
        ATR_PERIOD
    );

    const i = closedCandles.length - 1;

    const candle = closedCandles[i];
    const previousCandle = closedCandles[i - 1];

    const e50 = ema50[i];
    const e200 = ema200[i];
    const r = rsi[i];
    const a = atr[i];

    if (
        ![e50, e200, r, a].every(
            Number.isFinite
        ) ||
        a <= 0
    ) {
        setText(
            "signal-reason",
            "Calcul des indicateurs en cours."
        );

        return;
    }

    // Afficher les indicateurs.
    setText("ema50", formatPrice(e50));
    setText("ema200", formatPrice(e200));
    setText("rsi", r.toFixed(2));
    setText("atr", formatPrice(a));

    // Déterminer la tendance.
    let trend = "Neutre";

    if (
        e50 > e200 &&
        candle.close > e50
    ) {
        trend = "Haussière";
    } else if (
        e50 < e200 &&
        candle.close < e50
    ) {
        trend = "Baissière";
    }

    const trendNode = el("market-tendance");

    if (trendNode) {
        trendNode.style.color =
            trend === "Haussière"
                ? "#27ae60"
                : trend === "Baissière"
                    ? "#c0392b"
                    : "#f1c40f";
    }

    setText("market-tendance", trend);

    setText(
        "last-analysis",
        "Dernière analyse : " +
        new Date().toLocaleString("fr-FR") +
        " | Bougie H4 : " +
        formatTime(candle.epoch)
    );

    // Ne pas retraiter la même bougie clôturée.
    if (lastProcessedCandle === candle.epoch) {
        return;
    }

    lastProcessedCandle = candle.epoch;

    // Conditions de confirmation.
    const bullish =
        candle.close > candle.open;

    const bearish =
        candle.close < candle.open;

    const buySignal =
        e50 > e200 &&
        candle.close > e50 &&
        r >= 50 &&
        r <= 68 &&
        bullish &&
        candle.close > previousCandle.close;

    const sellSignal =
        e50 < e200 &&
        candle.close < e50 &&
        r >= 32 &&
        r <= 50 &&
        bearish &&
        candle.close < previousCandle.close;

    if (!buySignal && !sellSignal) {
        setText(
            "signal-reason",
            "Aucun signal confirmé. Tendance : " +
            trend +
            " | RSI : " +
            r.toFixed(2) +
            ". En attente d'une nouvelle bougie H4."
        );

        return;
    }

    const type = buySignal ? "BUY" : "SELL";

    const signalKey =
        type + "-" + candle.epoch;

    if (signalKey === lastSignalKey) {
        return;
    }

    lastSignalKey = signalKey;

    // Calcul du Stop Loss et du Take Profit.
    const entry = candle.close;

    const risk =
        a * SL_ATR_MULTIPLIER;

    const sl = type === "BUY"
        ? entry - risk
        : entry + risk;

    const tp = type === "BUY"
        ? entry + risk * REWARD_RISK_RATIO
        : entry - risk * REWARD_RISK_RATIO;

    triggerSignal({
        type: type,
        entry: entry,
        sl: sl,
        tp: tp,
        rsi: r,
        candleTime: candle.epoch,

        reason:
            "Signal " + type +
            " détecté sur H4. " +
            "EMA 50/200 alignées, RSI " +
            r.toFixed(2) +
            ", ATR " + formatPrice(a) +
            ". Ratio théorique : 1:2. " +
            "Source : Biquote."
    });
}

// ============================================
// 10. AFFICHAGE DES SIGNAUX
// ============================================

function triggerSignal(signal) {
    const type = signal.type;

    const badge = el("signal-type");

    if (badge) {
        badge.textContent = type;

        badge.className =
            "badge " + type.toLowerCase();
    }

    setText(
        "signal-entry",
        formatPrice(signal.entry)
    );

    setText(
        "signal-sl",
        formatPrice(signal.sl)
    );

    setText(
        "signal-tp",
        formatPrice(signal.tp)
    );

    setText("signal-rr", "1:2");
    setText("signal-conf", "Critères réunis");

    setText(
        "signal-time",
        "Bougie H4 : " +
        formatTime(signal.candleTime)
    );

    setText(
        "signal-reason",
        signal.reason
    );

    const tbody = document.querySelector(
        "#history-table tbody"
    );

    if (!tbody) {
        return;
    }

    const row = document.createElement("tr");

    const values = [
        formatTime(signal.candleTime),
        type,
        formatPrice(signal.entry),
        formatPrice(signal.sl),
        formatPrice(signal.tp),
        signal.rsi.toFixed(2)
    ];

    values.forEach(function (value, index) {
        const cell = document.createElement("td");

        cell.textContent = value;

        if (index === 1) {
            cell.className = type.toLowerCase();
        }

        row.appendChild(cell);
    });

    tbody.prepend(row);

    while (tbody.rows.length > 50) {
        tbody.deleteRow(
            tbody.rows.length - 1
        );
    }
}

// ============================================
// 11. BOUTON ACTUALISER
// ============================================

const refreshButton = el("refresh-button");

if (refreshButton) {
    refreshButton.addEventListener(
        "click",
        function () {
            fetchPrice();
            requestCandles();
        }
    );
}

// ============================================
// 12. CONNEXION INTERNET
// ============================================

window.addEventListener(
    "online",
    function () {
        if (!stopped) {
            fetchPrice();
            requestCandles();
        }
    }
);

window.addEventListener(
    "offline",
    function () {
        logStatus(
            "Internet indisponible. " +
            "En attente de la reconnexion."
        );
    }
);

// ============================================
// 13. DÉMARRAGE ET ARRÊT
// ============================================

function startBiquote() {
    stopped = false;

    clearInterval(refreshTimer);
    clearInterval(priceTimer);

    logStatus("Connexion à Biquote...");

    // Charger immédiatement les données.
    fetchPrice();
    requestCandles();

    // Actualiser les cotations toutes les 15 secondes.
    priceTimer = setInterval(
        fetchPrice,
        PRICE_REFRESH_MS
    );

    // Actualiser les bougies toutes les minutes.
    refreshTimer = setInterval(
        requestCandles,
        CANDLE_REFRESH_MS
    );
}

window.addEventListener(
    "beforeunload",
    function () {
        stopped = true;

        clearInterval(refreshTimer);
        clearInterval(priceTimer);
    }
);

// Lancement automatique du site.
startBiquote();
