"use strict";

// ============================================
// 1. CONFIGURATION
// ============================================

const APP_ID = 1089;
const WS_URL =
    "wss://ws.derivws.com/websockets/v3?app_id=" + APP_ID;

const SYMBOL = "frxXAUUSD";

const TIMEFRAME = 14400;
const CANDLE_COUNT = 300;

const EMA_FAST = 50;
const EMA_SLOW = 200;
const RSI_PERIOD = 14;
const ATR_PERIOD = 14;

const SL_ATR_MULTIPLIER = 1.5;
const REWARD_RISK_RATIO = 2;

// ============================================
// 2. VARIABLES
// ============================================

let ws = null;
let reconnectTimer = null;
let refreshTimer = null;
let timeoutTimer = null;

let requestId = 0;
let historyRequestId = null;
let requestInProgress = false;

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

function clearHistoryRequest() {
    clearTimeout(timeoutTimer);

    timeoutTimer = null;
    requestInProgress = false;
    historyRequestId = null;
}

// ============================================
// 4. CONNEXION À DERIV
// ============================================

function connectDeriv() {
    if (stopped) return;

    clearTimeout(reconnectTimer);
    clearInterval(refreshTimer);

    if (
        ws &&
        (ws.readyState === WebSocket.OPEN ||
         ws.readyState === WebSocket.CONNECTING)
    ) {
        return;
    }

    clearHistoryRequest();

    logStatus("Connexion à Deriv...");

    let socket;

    try {
        socket = new WebSocket(WS_URL);
        ws = socket;
    } catch (error) {
        console.error("Création WebSocket impossible :", error);

        logStatus("Impossible de créer la connexion WebSocket.");

        scheduleReconnect();

        return;
    }

    // Délai maximal de connexion.
    const connectionTimeout = setTimeout(function () {
        if (
            socket === ws &&
            socket.readyState === WebSocket.CONNECTING
        ) {
            logStatus("Connexion trop lente. Nouvelle tentative...");

            socket.close();
        }
    }, 15000);

    socket.onopen = function () {
        clearTimeout(connectionTimeout);

        if (socket !== ws) return;

        console.log("WebSocket connecté à Deriv.");

        logStatus("Connexion établie. Vérification du marché...");

        // Demander d'abord le nom et les caractéristiques
        // du symbole auprès de l'API.
        socket.send(JSON.stringify({
            active_symbols: "brief",
            product_type: "basic",
            req_id: ++requestId
        }));

        // Demander ensuite le prix en direct.
        socket.send(JSON.stringify({
            ticks: SYMBOL,
            subscribe: 1,
            req_id: ++requestId
        }));

        // Demander l'historique H4.
        requestCandles();

        refreshTimer = setInterval(function () {
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

        console.log("[DERIV]", data);

        // ----------------------------------------
        // GESTION DES ERREURS API
        // ----------------------------------------

        if (data.error) {
            const message = data.error.message || "Erreur inconnue";

            console.error("Erreur API Deriv :", data.error);

            if (
                data.echo_req &&
                data.echo_req.req_id === historyRequestId
            ) {
                clearHistoryRequest();
            }

            logStatus("Erreur Deriv : " + message);

            return;
        }

        // ----------------------------------------
        // VÉRIFICATION DES SYMBOLES
        // ----------------------------------------

        if (data.msg_type === "active_symbols") {
            const symbols = data.active_symbols || [];

            const gold = symbols.find(function (item) {
                return item.symbol === SYMBOL;
            });

            if (gold) {
                console.log(
                    "Symbole trouvé :",
                    gold.symbol,
                    gold.display_name
                );
            } else {
                console.warn(
                    "Le symbole " + SYMBOL +
                    " n'apparaît pas dans cette liste."
                );
            }

            return;
        }

        // ----------------------------------------
        // PRIX EN TEMPS RÉEL
        // ----------------------------------------

        if (data.msg_type === "tick" && data.tick) {
            currentPrice = Number(data.tick.quote);

            if (Number.isFinite(currentPrice)) {
                setText("current-price", formatPrice(currentPrice));

                setText(
                    "last-update",
                    new Date(data.tick.epoch * 1000)
                        .toLocaleTimeString("fr-FR")
                );

                if (candles.length > 0) {
                    logStatus(
                        "Connecté à Deriv — prix en direct",
                        true
                    );
                } else {
                    logStatus(
                        "Prix reçu. Chargement de l'historique...",
                        true
                    );
                }
            }

            return;
        }

        // ----------------------------------------
        // HISTORIQUE DES BOUGIES
        // ----------------------------------------

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
                logStatus("Historique H4 indisponible.");
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

            console.log("Bougies H4 reçues :", candles.length);

            if (candles.length === 0) {
                logStatus("Aucune bougie disponible.");
                return;
            }

            analyzeMarket();

            if (Number.isFinite(currentPrice)) {
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

            return;
        }

        // ----------------------------------------
        // AUTRES RÉPONSES
        // ----------------------------------------

        if (data.msg_type === "ping") {
            console.log("Réponse ping reçue.");
        }
    };

    socket.onerror = function (error) {
        if (socket !== ws) return;

        console.error("Erreur WebSocket :", error);

        logStatus(
            "Erreur WebSocket. Vérifie Internet et la connexion Deriv."
        );
    };

    socket.onclose = function (event) {
        clearTimeout(connectionTimeout);

        if (socket !== ws) return;

        console.warn(
            "Connexion fermée :",
            event.code,
            event.reason
        );alert(
    "Code : " + event.code +
    "\nRaison : " + (event.reason || "Aucune raison fournie")
);

        clearInterval(refreshTimer);
        refreshTimer = null;

        clearHistoryRequest();

        ws = null;

        if (!stopped) {
            logStatus(
                "Connexion fermée (code " + event.code +
                "). Reconnexion dans 5 secondes..."
            );

            scheduleReconnect();
        }
    };
}

// ============================================
// 5. RECONNEXION
// ============================================

function scheduleReconnect() {
    clearTimeout(reconnectTimer);

    if (stopped) return;

    reconnectTimer = setTimeout(function () {
        connectDeriv();
    }, 5000);
}

// ============================================
// 6. RÉCUPÉRATION DES BOUGIES
// ============================================

function requestCandles() {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        return;
    }

    if (requestInProgress) {
        return;
    }

    requestInProgress = true;

    const id = ++requestId;
    historyRequestId = id;

    try {
        ws.send(JSON.stringify({
            ticks_history: SYMBOL,
            style: "candles",
            granularity: TIMEFRAME,
            count: CANDLE_COUNT,
            end: "latest",
            req_id: id
        }));
    } catch (error) {
        console.error("Envoi de la demande impossible :", error);

        clearHistoryRequest();

        return;
    }

    timeoutTimer = setTimeout(function () {
        if (historyRequestId === id) {
            console.warn("Réponse historique trop lente.");

            clearHistoryRequest();

            logStatus(
                "Délai dépassé pendant le chargement des bougies."
            );
        }
    }, 15000);
}

// ============================================
// 7. EMA
// ============================================

function calculateEMA(values, period) {
    const result = new Array(values.length).fill(null);

    if (values.length < period) return result;

    let sum = 0;

    for (let i = 0; i < period; i++) {
        sum += values[i];
    }

    let ema = sum / period;

    result[period - 1] = ema;

    const multiplier = 2 / (period + 1);

    for (let i = period; i < values.length; i++) {
        ema = (values[i] - ema) * multiplier + ema;
        result[i] = ema;
    }

    return result;
}

// ============================================
// 8. RSI
// ============================================

function calculateRSI(values, period = 14) {
    const result = new Array(values.length).fill(null);

    if (values.length <= period) return result;

    let gains = 0;
    let losses = 0;

    for (let i = 1; i <= period; i++) {
        const difference = values[i] - values[i - 1];

        gains += Math.max(difference, 0);
        losses += Math.max(-difference, 0);
    }

    let averageGain = gains / period;
    let averageLoss = losses / period;

    function getRSI(gain, loss) {
        if (gain === 0 && loss === 0) return 50;
        if (loss === 0) return 100;

        return 100 - 100 / (1 + gain / loss);
    }

    result[period] = getRSI(averageGain, averageLoss);

    for (let i = period + 1; i < values.length; i++) {
        const difference = values[i] - values[i - 1];

        averageGain = (
            averageGain * (period - 1) +
            Math.max(difference, 0)
        ) / period;

        averageLoss = (
            averageLoss * (period - 1) +
            Math.max(-difference, 0)
        ) / period;

        result[i] = getRSI(averageGain, averageLoss);
    }

    return result;
}

// ============================================
// 9. ATR
// ============================================

function calculateATR(data, period = 14) {
    const result = new Array(data.length).fill(null);

    if (data.length <= period) return result;

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
        average = (
            average * (period - 1) + ranges[i]
        ) / period;

        result[i] = average;
    }

    return result;
}

// ============================================
// 10. ANALYSE H4
// ============================================

function analyzeMarket() {
    if (candles.length < EMA_SLOW + 5) {
        setText(
            "signal-reason",
            "Historique insuffisant : " +
            candles.length + " bougies reçues."
        );

        return;
    }

    const now = Math.floor(Date.now() / 1000);

    const closedCandles = candles.filter(function (c) {
        return c.epoch + TIMEFRAME <= now;
    });

    if (closedCandles.length < EMA_SLOW + 5) {
        setText(
            "signal-reason",
            "En attente d'au moins 205 bougies H4 clôturées."
        );

        return;
    }

    const closes = closedCandles.map(c => c.close);

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

    let trend = "Neutre";

    if (e50 > e200 && candle.close > e50) {
        trend = "Haussière";
    } else if (e50 < e200 && candle.close < e50) {
        trend = "Baissière";
    }

    const trendNode = el("market-tendance");

    if (trendNode) {
        trendNode.style.color =
            trend === "Haussière" ? "#27ae60" :
            trend === "Baissière" ? "#c0392b" :
            "#f1c40f";
    }

    setText("market-tendance", trend);

    setText(
        "last-analysis",
        "Dernière analyse : " +
        new Date().toLocaleString("fr-FR") +
        " | Bougie : " +
        formatTime(candle.epoch)
    );

    if (lastProcessedCandle === candle.epoch) {
        return;
    }

    lastProcessedCandle = candle.epoch;

    const bullish = candle.close > candle.open;
    const bearish = candle.close < candle.open;

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
            trend + " | RSI : " + r.toFixed(2)
        );

        return;
    }

    const type = buySignal ? "BUY" : "SELL";
    const signalKey = type + "-" + candle.epoch;

    if (signalKey === lastSignalKey) return;

    lastSignalKey = signalKey;

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
            ". Ratio théorique : 1:2."
    });
}

// ============================================
// 11. AFFICHAGE DU SIGNAL
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
// 12. BOUTON ACTUALISER
// ============================================

const refreshButton = el("refresh-button");

if (refreshButton) {
    refreshButton.addEventListener("click", function () {
        if (requestInProgress) {
            logStatus("Chargement des données en cours...");
            return;
        }

        requestCandles();
    });
}

// ============================================
// 13. INTERNET
// ============================================

window.addEventListener("online", function () {
    if (!ws || ws.readyState === WebSocket.CLOSED) {
        connectDeriv();
    }
});

window.addEventListener("offline", function () {
    logStatus("Internet indisponible.");
});

// ============================================
// 14. FERMETURE
// ============================================

window.addEventListener("beforeunload", function () {
    stopped = true;

    clearTimeout(reconnectTimer);
    clearInterval(refreshTimer);
    clearTimeout(timeoutTimer);

    if (ws) {
        ws.close();
    }
});

// ============================================
// 15. DÉMARRAGE
// ==============
