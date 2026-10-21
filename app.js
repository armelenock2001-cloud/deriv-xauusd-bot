"use strict";

// ============================================
// 1. CONFIGURATION
// ============================================

const WS_URL = "wss://ws.derivws.com/websockets/v3?app_id=1089";
const SYMBOL = "frxXAUUSD";

const TIMEFRAME = 14400; // H4
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
let requestTimeout = null;

let requestInProgress = false;
let candles = [];
let currentPrice = null;
let requestId = 0;
let historyRequestId = null;
let lastProcessedCandle = null;
let lastSignalKey = null;
let tickSubscribed = false;
let stopped = false;

// ============================================
// 2. OUTILS
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
    const node = el("connection-status");

    if (node) {
        node.textContent = message;
        node.className =
            "status " + (connected ? "connected" : "disconnected");
    }

    console.log("[ROBOT H4]", message);
}

function formatPrice(value) {
    return Number.isFinite(value) ? value.toFixed(2) : "--";
}

function formatTime(epoch) {
    return new Date(epoch * 1000).toLocaleString("fr-FR");
}

function clearHistoryRequest() {
    clearTimeout(requestTimeout);
    requestTimeout = null;

    requestInProgress = false;
    historyRequestId = null;
}

// ============================================
// 3. CONNEXION DERIV
// ============================================

function connectDeriv() {
    if (stopped) return;

    clearTimeout(reconnectTimer);
    clearInterval(requestTimer);

    if (
        ws &&
        (ws.readyState === WebSocket.OPEN ||
         ws.readyState === WebSocket.CONNECTING)
    ) {
        return;
    }

    clearHistoryRequest();

    tickSubscribed = false;

    logStatus("Connexion à Deriv...");

    try {
        ws = new WebSocket(WS_URL);
    } catch (error) {
        console.error("Erreur de création WebSocket :", error);

        logStatus("Impossible de créer la connexion.");
        scheduleReconnect();

        return;
    }

    const socket = ws;

    socket.onopen = function () {
        if (socket !== ws) return;

        console.log("Connexion WebSocket établie.");

        logStatus("Connecté. Chargement des données...");

        // Souscription au prix en temps réel.
        socket.send(JSON.stringify({
            ticks: SYMBOL,
            subscribe: 1,
            req_id: ++requestId
        }));

        // Première récupération des bougies.
        requestCandles();

        // Actualisation toutes les 60 secondes.
        requestTimer = setInterval(function () {
            requestCandles();
        }, 60000);
    };

    socket.onmessage = function (event) {
        if (socket !== ws) return;

        let data;

        try {
            data = JSON.parse(event.data);
        } catch (error) {
            console.error("Réponse JSON invalide :", error);
            return;
        }

        // Gestion des erreurs Deriv.
        if (data.error) {
            console.error("Erreur Deriv :", data.error);

            if (
                data.echo_req &&
                data.echo_req.req_id === historyRequestId
            ) {
                clearHistoryRequest();
            }

            logStatus("Erreur Deriv : " + data.error.message);

            return;
        }

        // ------------------------------------
        // PRIX EN TEMPS RÉEL
        // ------------------------------------

        if (data.msg_type === "tick") {
            tickSubscribed = true;

            currentPrice = Number(data.tick.quote);

            if (Number.isFinite(currentPrice)) {
                setText("current-price", formatPrice(currentPrice));

                setText(
                    "last-update",
                    new Date(data.tick.epoch * 1000)
                        .toLocaleTimeString("fr-FR")
                );
            }

            if (candles.length > 0) {
                logStatus(
                    "Connecté — prix en direct et analyse H4",
                    true
                );
            }

            return;
        }

        // ------------------------------------
        // HISTORIQUE DES BOUGIES
        // ------------------------------------

        if (data.msg_type === "history") {
            if (
                !data.echo_req ||
                data.echo_req.req_id !== historyRequestId
            ) {
                return;
            }

            clearHistoryRequest();

            if (
                !data.history ||
                !Array.isArray(data.history.candles)
            ) {
                logStatus("Aucune bougie reçue de Deriv.");
                return;
            }

            candles = data.history.candles
                .map(function (c) {
                    return {
                        epoch: Number(c.epoch),
                        open: Number(c.open),
                        high: Number(c.high),
                        low: Number(c.low),
                        close: Number(c.close)
                    };
                })
                .filter(function (c) {
                    return [
                        c.epoch,
                        c.open,
                        c.high,
                        c.low,
                        c.close
                    ].every(Number.isFinite);
                })
                .sort(function (a, b) {
                    return a.epoch - b.epoch;
                });

            console.log(
                "Bougies reçues :",
                candles.length
            );

            if (candles.length === 0) {
                logStatus("Aucune bougie H4 disponible.");
                return;
            }

            analyzeMarket();

            if (tickSubscribed) {
                logStatus(
                    "Connecté — prix en direct et analyse H4",
                    true
                );
            } else {
                logStatus(
                    "Historique reçu : " + candles.length + " bougies",
                    true
                );
            }
        }
    };

    socket.onerror = function (error) {
        if (socket !== ws) return;

        console.error("Erreur WebSocket :", error);

        logStatus("Erreur de connexion à Deriv.");
    };

    // ------------------------------------
    // FERMETURE ET RECONNEXION
    // ------------------------------------

    socket.onclose = function (event) {
        if (socket !== ws) return;

        console.log(
            "Connexion fermée :",
            event.code,
            event.reason
        );

        clearInterval(requestTimer);
        requestTimer = null;

        clearHistoryRequest();

        tickSubscribed = false;
        ws = null;

        if (!stopped) {
            logStatus(
                "Déconnecté. Reconnexion dans 5 secondes..."
            );

            scheduleReconnect();
        }
    };
}

function scheduleReconnect() {
    clearTimeout(reconnectTimer);

    if (stopped) return;

    reconnectTimer = setTimeout(function () {
        connectDeriv();
    }, 5000);
}

// ============================================
// 4. RÉCUPÉRATION DES BOUGIES H4
// ============================================

function requestCandles() {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        return;
    }

    if (requestInProgress) {
        return;
    }

    requestInProgress = true;
    historyRequestId = ++requestId;

    const sentId = historyRequestId;

    const message = {
        ticks_history: SYMBOL,
        style: "candles",
        granularity: TIMEFRAME,
        count: CANDLE_COUNT,
        end: "latest",
        req_id: sentId
    };

    try {
        ws.send(JSON.stringify(message));
    } catch (error) {
        console.error("Erreur lors de la demande des bougies :", error);

        clearHistoryRequest();

        return;
    }

    requestTimeout = setTimeout(function () {
        if (
            requestInProgress &&
            historyRequestId === sentId
        ) {
            console.warn("Délai de réponse Deriv dépassé.");

            clearHistoryRequest();

            if (candles.length === 0) {
                logStatus(
                    "Délai dépassé. Vérifie la connexion Deriv."
                );
            }
        }
    }, 15000);
}

// ============================================
// 5. CALCUL EMA
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
// 6. CALCUL RSI
// ============================================

function calculateRSI(values, period = 14) {
    const result = new Array(values.length).fill(null);

    if (values.length <= period) {
        return result;
    }

    let gains = 0;
    let losses = 0;

    for (let i = 1; i <= period; i++) {
        const difference = values[i] - values[i - 1];

        if (difference > 0) {
            gains += difference;
        } else {
            losses -= difference;
        }
    }

    let averageGain = gains / period;
    let averageLoss = losses / period;

    result[period] = averageLoss === 0
        ? (averageGain === 0 ? 50 : 100)
        : 100 - 100 / (1 + averageGain / averageLoss);

    for (let i = period + 1; i < values.length; i++) {
        const difference = values[i] - values[i - 1];

        const gain = Math.max(difference, 0);
        const loss = Math.max(-difference, 0);

        averageGain =
            (averageGain * (period - 1) + gain) / period;

        averageLoss =
            (averageLoss * (period - 1) + loss) / period;

        result[i] = averageLoss === 0
            ? (averageGain === 0 ? 50 : 100)
            : 100 - 100 / (1 + averageGain / averageLoss);
    }

    return result;
}

// ============================================
// 7. CALCUL ATR
// ============================================

function calculateATR(data, period = 14) {
    const result = new Array(data.length).fill(null);

    if (data.length <= period) {
        return result;
    }

    const ranges = [];

    for (let i = 0; i < data.length; i++) {
        if (i === 0) {
            ranges.push(data[i].high - data[i].low);
            continue;
        }

        const previousClose = data[i - 1].close;

        ranges.push(Math.max(
            data[i].high - data[i].low,
            Math.abs(data[i].high - previousClose),
            Math.abs(data[i].low - previousClose)
        ));
    }

    let average = 0;

    for (let i = 1; i <= period; i++) {
        average += ranges[i];
    }

    average /= period;

    result[period] = average;

    for (let i = period + 1; i < data.length; i++) {
        average =
            (average * (period - 1) + ranges[i]) / period;

        result[i] = average;
    }

    return result;
}

// ============================================
// 8. ANALYSE AUTOMATIQUE H4
// ============================================

function analyzeMarket() {
    if (candles.length < EMA_SLOW + 5) {
        setText(
            "signal-reason",
            "Historique insuffisant : " + candles.length +
            " bougies. Le robot a besoin d'au moins 205 bougies."
        );

        return;
    }

    const now = Math.floor(Date.now() / 1000);

    // On conserve uniquement les bougies clôturées.
    const closedCandles = candles.filter(function (c) {
        return c.epoch + TIMEFRAME <= now;
    });

    if (closedCandles.length < EMA_SLOW + 5) {
        setText(
            "signal-reason",
            "En attente d'un historique H4 suffisant."
        );

        return;
    }

    const closes = closedCandles.map(function (c) {
        return c.close;
    });

    const ema50 = calculateEMA(closes, EMA_FAST);
    const ema200 = calculateEMA(closes, EMA_SLOW);
    const rsi = calculateRSI(closes, RSI_PERIOD);
    const atr = calculateATR(closedCandles, ATR_PERIOD);

    const i = closedCandles.length - 1;

    const candle = closedCandles[i];
    const previousCandle = closedCandles[i - 1];

    const e50 = ema50[i];
    const e200 = ema200[i];
    const r = rsi[i];
    const a = atr[i];

    if (
        ![e50, e200, r, a].every(Number.isFinite) ||
        a <= 0
    ) {
        setText(
            "signal-reason",
            "Calcul des indicateurs en cours."
        );

        return;
    }

    setText("ema50", formatPrice(e50));
    setText("ema200", formatPrice(e200));
    setText("rsi", r.toFixed(2));
    setText("atr", formatPrice(a));

    // Tendance générale.
    let trend = "Neutre";

    const trendNode = el("market-tendance");

    if (e50 > e200 && candle.close > e50) {
        trend = "Haussière";

        if (trendNode) {
            trendNode.style.color = "#27ae60";
        }
    } else if (e50 < e200 && candle.close < e50) {
        trend = "Baissière";

        if (trendNode) {
            trendNode.style.color = "#c0392b";
        }
    } else if (trendNode) {
        trendNode.style.color = "#f1c40f";
    }

    setText("market-tendance", trend);

    setText(
        "last-analysis",
        "Dernière analyse : " +
        new Date().toLocaleString("fr-FR") +
        " | Bougie clôturée : " +
        formatTime(candle.epoch)
    );

    // Éviter de traiter plusieurs fois la même bougie.
    if (lastProcessedCandle === candle.epoch) {
        return;
    }

    lastProcessedCandle = candle.epoch;

    const bullish = candle.close > candle.open;
    const bearish = candle.close < candle.open;

    // Confirmation BUY.
    const buySignal =
        e50 > e200 &&
        candle.close > e50 &&
        r >= 50 &&
        r <= 68 &&
        bullish &&
        candle.close > previousCandle.close;

    // Confirmation SELL.
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
            ". En attente de confirmations techniques."
        );

        return;
    }

    const type = buySignal ? "BUY" : "SELL";
    const signalKey = type + "-" + candle.epoch;

    if (signalKey === lastSignalKey) {
        return;
    }

    lastSignalKey = signalKey;

    // Entrée théorique à la clôture de la bougie.
    const entry = candle.close;

    const risk = a * SL_ATR_MULTIPLIER;

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
            " détecté sur H4. EMA 50/200 alignées, RSI " +
            r.toFixed(2) +
            ", ATR " + formatPrice(a) +
            ". Ratio théorique gain/risque : 1:2."
    });
}

// ============================================
// 9. AFFICHAGE DES SIGNAUX
// ============================================

function triggerSignal(signal) {
    const type = signal.type;

    const badge = el("signal-type");

    if (badge) {
        badge.textContent = type;
        badge.className = "badge " + type.toLowerCase();
    }

    setText("signal-entry", formatPrice(signal.entry));
    setText("signal-sl", formatPrice(signal.sl));
    setText("signal-tp", formatPrice(signal.tp));
    setText("signal-rr", "1:2");
    setText("signal-conf", "Critères réunis");

    setText(
        "signal-time",
        "Bougie H4 : " + formatTime(signal.candleTime)
    );

    setText("signal-reason", signal.reason);

    const tbody = document.querySelector("#history-table tbody");

    if (!tbody) return;

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
        tbody.deleteRow(tbody.rows.length - 1);
    }
}

// ============================================
// 10. BOUTON ACTUALISER
// ============================================

const refreshButton = el("refresh-button");

if (refreshButton) {
    refreshButton.addEventListener("click", function () {
        if (requestInProgress) {
            logStatus("Récupération des données en cours...");
            return;
        }

        requestCandles();
    });
}

// ============================================
// 11. CONNEXION INTERNET
// ============================================

window.addEventListener("online", function () {
    if (!ws || ws.readyState === WebSocket.CLOSED) {
        connectDeriv();
    }
});

window.addEventListener("offline", function () {
    logStatus("Internet indisponible. En attente du réseau...");
});

// ============================================
// 12. FERMETURE DE LA PAGE
// ============================================

window.addEventListener("beforeunload", function () {
    stopped = true;

    clearInterval(requestTimer);
    clearTimeout(reconnectTimer);
    clearTimeout(requestTimeout);

    if (ws) {
        ws.close();
    }
});

// ============================================
// 13. DÉMARRAGE AUTOMATIQUE
// ============================================

connectDeriv();
