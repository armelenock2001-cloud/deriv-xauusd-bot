"use strict";

// ============================================
// CONFIGURATION
// ============================================

const WS_URL = "wss://ws.derivws.com/websockets/v3?app_id=1089";
const SYMBOL = "frxXAUUSD";

const TIMEFRAME_SECONDS = 4 * 60 * 60;
const CANDLE_COUNT = 300;

const EMA_FAST = 50;
const EMA_SLOW = 200;
const RSI_PERIOD = 14;
const ATR_PERIOD = 14;

const SL_ATR_MULTIPLIER = 1.5;
const REWARD_RISK_RATIO = 2;

let ws = null;
let reconnectTimer = null;
let requestTimer = null;
let requestInProgress = false;
let lastProcessedCandle = null;
let lastSignalKey = null;
let candles = [];
let currentPrice = null;
let currentRequestId = 0;

// ============================================
// OUTILS D'AFFICHAGE
// ============================================

function element(id) {
    return document.getElementById(id);
}

function logStatus(message, connected = false) {
    const el = element("connection-status");

    el.textContent = message;
    el.className = "status " +
        (connected ? "connected" : "disconnected");
}

function formatPrice(value) {
    if (!Number.isFinite(value)) return "--";
    return value.toFixed(2);
}

function formatDate(epoch) {
    return new Date(epoch * 1000).toLocaleString("fr-FR");
}

function setText(id, value) {
    const el = element(id);
    if (el) el.textContent = value;
}

// ============================================
// CONNEXION DERIV
// ============================================

function connectDeriv() {
    clearTimeout(reconnectTimer);

    logStatus("Connexion à Deriv...");

    try {
        ws = new WebSocket(WS_URL);
    } catch (error) {
        logStatus("Impossible de créer la connexion.");
        scheduleReconnect();
        return;
    }

    ws.onopen = () => {
        logStatus("Connecté. Chargement des bougies...");

        requestCandles();
        requestTimer = setInterval(requestCandles, 60000);
    };

    ws.onmessage = event => {
        let data;

        try {
            data = JSON.parse(event.data);
        } catch (error) {
            console.error("Réponse Deriv invalide", error);
            return;
        }

        if (data.error) {
            console.error("Erreur Deriv :", data.error);
            logStatus("Erreur Deriv : " + data.error.message);
            requestInProgress = false;
            return;
        }

        if (data.msg_type === "history") {
            if (data.echo_req &&
                data.echo_req.req_id !== currentRequestId) {
                return;
            }

            requestInProgress = false;

            if (!data.history || !data.history.candles) {
                logStatus("Aucune bougie reçue.");
                return;
            }

            candles = data.history.candles
                .map(c => ({
                    epoch: Number(c.epoch),
                    open: Number(c.open),
                    high: Number(c.high),
                    low: Number(c.low),
                    close: Number(c.close)
                }))
                .filter(c =>
                    Number.isFinite(c.epoch) &&
                    Number.isFinite(c.open) &&
                    Number.isFinite(c.high) &&
                    Number.isFinite(c.low) &&
                    Number.isFinite(c.close)
                )
                .sort((a, b) => a.epoch - b.epoch);

            analyzeMarket();
        }

        if (data.msg_type === "tick") {
            currentPrice = Number(data.tick.quote);

            if (Number.isFinite(currentPrice)) {
                setText("current-price", formatPrice(currentPrice));
                setText(
                    "last-update",
                    new Date(data.tick.epoch * 1000)
                        .toLocaleTimeString("fr-FR")
                );
            }
        }
    };

    ws.onerror = error => {
        console.error("WebSocket :", error);
        logStatus("Erreur de connexion.");
    };

    ws.onclose = () => {
        clearInterval(requestTimer);
        requestInProgress = false;
        logStatus("Déconnecté. Reconnexion...");
        scheduleReconnect();
    };
}

function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectDeriv, 5000);
}

function requestCandles() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (requestInProgress) return;

    requestInProgress = true;
    currentRequestId++;

    ws.send(JSON.stringify({
        ticks_history: SYMBOL,
        style: "candles",
        granularity: TIMEFRAME_SECONDS,
        count: CANDLE_COUNT,
        end: "latest",
        req_id: currentRequestId
    }));
}

// ============================================
// INDICATEURS TECHNIQUES
// ============================================

function calculateEMA(values, period) {
    if (values.length < period) return [];

    const result = new Array(values.length).fill(null);
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

function calculateRSI(values, period = 14) {
    const result = new Array(values.length).fill(null);

    if (values.length <= period) return result;

    let gains = 0;
    let losses = 0;

    for (let i = 1; i <= period; i++) {
        const change = values[i] - values[i - 1];

        if (change > 0) gains += change;
        else losses -= change;
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

    result[period] = avgLoss === 0
        ? 100
        : 100 - 100 / (1 + avgGain / avgLoss);

    for (let i = period + 1; i < values.length; i++) {
        const change = values[i] - values[i - 1];

        const gain = Math.max(change, 0);
        const loss = Math.max(-change, 0);

        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;

        result[i] = avgLoss === 0
            ? 100
            : 100 - 100 / (1 + avgGain / avgLoss);
    }

    return result;
}

function calculateATR(data, period = 14) {
    const result = new Array(data.length).fill(null);

    if (data.length <= period) return result;

    const trueRanges = [];

    for (let i = 0; i < data.length; i++) {
        if (i === 0) {
            trueRanges.push(data[i].high - data[i].low);
            continue;
        }

        const previousClose = data[i - 1].close;

        trueRanges.push(Math.max(
            data[i].high - data[i].low,
            Math.abs(data[i].high - previousClose),
            Math.abs(data[i].low - previousClose)
        ));
    }

    let atr = 0;

    for (let i = 1; i <= period; i++) {
        atr += trueRanges[i];
    }

    atr /= period;
    result[period] = atr;

    for (let i = period + 1; i < data.length; i++) {
        atr = (
            atr * (period - 1) + trueRanges[i]
        ) / period;

        result[i] = atr;
    }

    return result;
}

// ============================================
// ANALYSE H4
// ============================================

function analyzeMarket() {
    if (candles.length < EMA_SLOW + 5) {
        logStatus("Historique insuffisant pour EMA 200.");
        setText(
            "signal-reason",
            "Le robot attend suffisamment de bougies H4."
        );
        return;
    }

    // Une bougie en formation ne doit pas influencer le signal.
    const now = Math.floor(Date.now() / 1000);

    const closedCandles = candles.filter(c =>
        c.epoch + TIMEFRAME_SECONDS <= now
    );

    if (closedCandles.length < EMA_SLOW + 5) {
        logStatus("En attente de bougies H4 clôturées.");
        return;
    }

    const closes = closedCandles.map(c => c.close);

    const ema50 = calculateEMA(closes, EMA_FAST);
    const ema200 = calculateEMA(closes, EMA_SLOW);
    const rsi = calculateRSI(closes, RSI_PERIOD);
    const atr = calculateATR(closedCandles, ATR_PERIOD);

    const i = closedCandles.length - 1;
    const candle = closedCandles[i];

    const e50 = ema50[i];
    const e200 = ema200[i];
    const r = rsi[i];
    const a = atr[i];

    if (![e50, e200, r, a].every(Number.isFinite) || a <= 0) {
        setText("signal-reason", "Indicateurs en cours de calcul.");
        return;
    }

    setText("ema50", formatPrice(e50));
    setText("ema200", formatPrice(e200));
    setText("rsi", r.toFixed(1));
    setText("atr", formatPrice(a));

    let trend = "Neutre";

    if (e50 > e200 && candle.close > e50) {
        trend = "Haussière";
        element("market-tendance").style.color = "#27ae60";
    } else if (e50 < e200 && candle.close < e50) {
        trend = "Baissière";
        element("market-tendance").style.color = "#c0392b";
    } else {
        element("market-tendance").style.color = "#f1c40f";
    }

    setText("market-tendance", trend);

    setText(
        "last-analysis",
        "Dernière analyse : " + new Date().toLocaleString("fr-FR") +
        " | Bougie H4 clôturée : " + formatDate(candle.epoch)
    );

    logStatus("Données H4 actualisées", true);

    // Une seule évaluation par bougie clôturée.
    if (candle.epoch === lastProcessedCandle) return;

    lastProcessedCandle = candle.epoch;

    const previousClose = closedCandles[i - 1].close;

    const bullishCandle = candle.close > candle.open;
    const bearishCandle = candle.close < candle.open;

    const buySignal =
        e50 > e200 &&
        candle.close > e50 &&
        r >= 50 &&
        r <= 68 &&
        bullishCandle &&
        candle.close > previousClose;

    const sellSignal =
        e50 < e200 &&
        candle.close < e50 &&
        r >= 32 &&
        r <= 50 &&
        bearishCandle &&
        candle.close < previousClose;

    if (!buySignal && !sellSignal) {
        setText(
            "signal-reason",
            "Aucun signal confirmé sur la dernière bougie H4. " +
            "Tendance : " + trend +
            " | RSI : " + r.toFixed(1) +
            ". Le robot attend une configuration conforme aux critères."
        );
        return;
    }

    const type = buySignal ? "BUY" : "SELL";

    const key = type + "-" + candle.epoch;

    if (key === lastSignalKey) return;
    lastSignalKey = key;

    // Entrée indicative : clôture de la bougie de confirmation.
    const entry = candle.close;

    const risk = a * SL_ATR_MULTIPLIER;

    const sl = type === "BUY"
        ? entry - risk
        : entry + risk;

    const tp = type === "BUY"
        ? entry + risk * REWARD_RISK_RATIO
        : entry - risk * REWARD_RISK_RATIO;

    const reason =
        "Signal " + type +
        " confirmé à la clôture H4. " +
        "EMA 50/200 : alignement favorable. " +
        "RSI 14 : " + r.toFixed(1) +
        ". ATR 14 : " + formatPrice(a) +
        ". Ratio théorique gain/risque : 2:1.";

    triggerSignal({
        type,
        entry,
        sl,
        tp,
        rsi: r,
        candleTime: candle.epoch,
        reason
    });
}

// ============================================
// AFFICHAGE DES SIGNAUX
// ============================================

function triggerSignal(signal) {
    const {
        type, entry, sl, tp, rsi, candleTime, reason
    } = signal;

    const badge = element("signal-type");
    badge.textContent = type;
    badge.className = "badge " + type.toLowerCase();

    setText("signal-entry", formatPrice(entry));
    setText("signal-sl", formatPrice(sl));
    setText("signal-tp", formatPrice(tp));
    setText("signal-rr", "1:2");
    setText("signal-conf", "Critères techniques réunis");
    setText("signal-time", "Bougie H4 : " + formatDate(candleTime));
    setText("signal-reason", reason);

    const tbody = document.querySelector("#history-table tbody");
    const row = document.createElement("tr");

    const values = [
        formatDate(candleTime),
        type,
        formatPrice(entry),
        formatPrice(sl),
        formatPrice(tp),
        rsi.toFixed(1)
    ];

    values.forEach((value, index) => {
        const td = document.createElement("td");

        // Afficher les données comme texte, sans HTML fourni par le serveur.
        td.textContent = value;

        if (index === 1) {
            td.className = type.toLowerCase();
        }

        row.appendChild(td);
    });

    tbody.prepend(row);

    // Conserver les 50 signaux les plus récents.
    while (tbody.rows.length > 50) {
        tbody.deleteRow(tbody.rows.length - 1);
    }
}

// ============================================
// BOUTON D'ACTUALISATION
// ============================================

element("refresh-button").addEventListener("click", () => {
    if (requestInProgress) return;

    requestCandles();
});

window.addEventListener("online", () => {
    if (!ws || ws.readyState === WebSocket.CLOSED) {
        connectDeriv();
    }
});

window.addEventListener("beforeunload", () => {
    clearInterval(requestTimer);
    clearTimeout(reconnectTimer);

    if (ws) ws.close();
});

connectDeriv();
