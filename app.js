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
// 3. OUTILS D'AFFICHAGE
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
    if (!Number.isFinite(value)) {
        return "--";
    }

    return value.toFixed(2);
}

function setStatus(message, connected = false) {
    const element = getElement("connection-status");

    if (!element) return;

    element.textContent = message;

    element.style.color = connected ? "#22c55e" : "#f59e0b";
}

// ============================================
// 4. RÉCUPÉRATION DU PRIX DE L'OR
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

        if (
            typeof data.mid !== "number" ||
            !Number.isFinite(data.mid) ||
            data.mid <= 0
        ) {
            throw new Error("Prix invalide reçu de Biquote.");
        }

        if (data.stale === true) {
            throw new Error("Le prix reçu est ancien.");
        }

        currentPrice = data.mid;

        setText("current-price", formatPrice(currentPrice));

        const now = new Date();

        setText(
            "last-update",
            now.toLocaleTimeString("fr-FR")
        );

        return true;

    } catch (error) {
        console.error("Erreur récupération du prix :", error);

        setText("current-price", "--");

        return false;
    }
}

// ============================================
// 5. RÉCUPÉRATION DES BOUGIES H4
// ============================================

async function fetchCandles() {
    try {
        const url =
            `${API_URL}/${SYMBOL}/ohlc` +
            `?interval=${TIMEFRAME}&limit=${CANDLE_COUNT}`;

        const response = await fetch(url, {
            cache: "no-store"
        });

        if (!response.ok) {
            throw new Error(`Erreur HTTP ${response.status}`);
        }

        const data = await response.json();

        if (!Array.isArray(data.bars)) {
            throw new Error("Les bougies sont absentes de la réponse.");
        }

        const now = Date.now();

        // On conserve les bougies valides et clôturées.
        const validCandles = data.bars
            .filter(candle => {
                const open = Number(candle.open);
                const high = Number(candle.high);
                const low = Number(candle.low);
                const close = Number(candle.close);

                return (
                    Number.isFinite(open) &&
                    Number.isFinite(high) &&
                    Number.isFinite(low) &&
                    Number.isFinite(close) &&
                    open > 0 &&
                    high > 0 &&
                    low > 0 &&
                    close > 0 &&
                    high >= low &&
                    candle.isOpen !== true
                );
            })
            .filter(candle => {
                const timestamp = Date.parse(candle.openTime);

                // Si l'heure est disponible, vérifie que la
                // bougie de 4 heures est bien clôturée.
                if (Number.isFinite(timestamp)) {
                    return timestamp + 4 * 60 * 60 * 1000 <= now;
                }

                return true;
            })
            .map(candle => ({
                time: candle.openTime,
                open: Number(candle.open),
                high: Number(candle.high),
                low: Number(candle.low),
                close: Number(candle.close)
            }))
            .sort((a, b) => {
                return Date.parse(a.time) - Date.parse(b.time);
            });

        // Supprime les éventuelles bougies en double.
        candles = validCandles.filter((candle, index, array) => {
            if (index === 0) return true;

            return candle.time !== array[index - 1].time;
        });

        console.log(
            `Bougies H4 reçues : ${candles.length}`
        );

        return candles;

    } catch (error) {
        console.error("Erreur récupération des bougies :", error);

        candles = [];

        throw error;
    }
}

// ============================================
// 6. CALCUL DE L'EMA
// ============================================

function calculateEMA(values, period) {
    if (!values.length) {
        return null;
    }

    const multiplier = 2 / (period + 1);

    // Avec moins de bougies que la période demandée,
    // le résultat est provisoire.
    let ema = values[0];

    for (let i = 1; i < values.length; i++) {
        ema =
            values[i] * multiplier +
            ema * (1 - multiplier);
    }

    return ema;
}

// ============================================
// 7. CALCUL DU RSI
// ============================================

function calculateRSI(values, period = 14) {
    if (values.length < 2) {
        return null;
    }

    const availablePeriod = Math.min(
        period,
        values.length - 1
    );

    let gains = 0;
    let losses = 0;

    const start = values.length - availablePeriod;

    for (let i = start; i < values.length; i++) {
        const change = values[i] - values[i - 1];

        if (change > 0) {
            gains += change;
        } else {
            losses += Math.abs(change);
        }
    }

    const averageGain = gains / availablePeriod;
    const averageLoss = losses / availablePeriod;

    if (averageGain === 0 && averageLoss === 0) {
        return 50;
    }

    if (averageLoss === 0) {
        return 100;
    }

    const relativeStrength = averageGain / averageLoss;

    return 100 - 100 / (1 + relativeStrength);
}

// ============================================
// 8. CALCUL DE L'ATR
// ============================================

function calculateATR(data, period = 14) {
    if (data.length < 2) {
        return null;
    }

    const trueRanges = [];

    for (let i = 1; i < data.length; i++) {
        const current = data[i];
        const previous = data[i - 1];

        const trueRange = Math.max(
            current.high - current.low,
            Math.abs(current.high - previous.close),
            Math.abs(current.low - previous.close)
        );

        trueRanges.push(trueRange);
    }

    if (!trueRanges.length) {
        return null;
    }

    const availablePeriod = Math.min(
        period,
        trueRanges.length
    );

    const recentRanges = trueRanges.slice(-availablePeriod);

    return recentRanges.reduce(
        (sum, value) => sum + value,
        0
    ) / availablePeriod;
}

// ============================================
// 9. AFFICHAGE DES INDICATEURS
// ============================================

function displayIndicators(ema50, ema200, rsi, atr) {
    setText("ema50", formatPrice(ema50));
    setText("ema200", formatPrice(ema200));

    setText(
        "rsi",
        Number.isFinite(rsi) ? rsi.toFixed(2) : "--"
    );

    setText("atr", formatPrice(atr));
}

// ============================================
// 10. AFFICHAGE DE LA TENDANCE
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
        formatPrice(sl),
        formatPrice(tp),
        rsi.toFixed(2)
    ];

    values.forEach(value => {
        const cell = document.createElement("td");

        cell.textContent = value;

        row.appendChild(cell);
    });

    table.prepend(row);

    // Limite l'historique affiché à 30 signaux.
    while (table.children.length > 30) {
        table.removeChild(table.lastElementChild);
    }
}

// ============================================
// 12. AFFICHAGE DU SIGNAL
// ============================================

function displaySignal(
    type,
    entry,
    sl,
    tp,
    trend,
    reason,
    rsi
) {
    setText("signal-type", type);
    setText("signal-entry", formatPrice(entry));
    setText("signal-sl", formatPrice(sl));
    setText("signal-tp", formatPrice(tp));

    setText("signal-rr", "1:2");

    setText(
        "signal-conf",
        "Conditions techniques réunies"
    );

    setText("signal-reason", reason);

    setText(
        "signal-time",
        new Date().toLocaleString("fr-FR")
    );

    const signalElement = getElement("signal-type");

    if (signalElement) {
        signalElement.style.color =
            type === "ACHAT" ? "#22c55e" : "#ef4444";
    }

    const key = [
        type,
        candles[candles.length - 1]?.time
    ].join("-");

    if (key !== lastSignalKey) {
        saveSignal(type, entry, sl, tp, rsi);
        lastSignalKey = key;
    }
}

// ============================================
// 13. ANALYSE DU MARCHÉ
// ============================================

async function analyzeMarket() {
    if (isAnalyzing) return;

    isAnalyzing = true;

    try {
        setText("last-analysis", "Analyse en cours...");

        await fetchPrice();

        await fetchCandles();

        if (candles.length < 50) {
            setText("signal-type", "EN ATTENTE");

            setText(
                "signal-reason",
                `Historique insuffisant : ${candles.length} bougies reçues. Il faut au moins 50 bougies pour commencer l'analyse.`
            );

            setText("last-analysis", "Données insuffisantes");

            setStatus("Prix connecté, historique insuffisant", false);

            return;
        }

        const closes = candles.map(candle => candle.close);

        const ema50 = calculateEMA(closes, EMA_FAST);
        const ema200 = calculateEMA(closes, EMA_SLOW);

        const rsi = calculateRSI(closes, RSI_PERIOD);
        const atr = calculateATR(candles, ATR_PERIOD);

        const lastCandle = candles[candles.length - 1];
        const close = lastCandle.close;

        displayIndicators(ema50, ema200, rsi, atr);

        const trend = displayTrend(ema50, ema200, close);

        const historyIsShort = candles.length < EMA_SLOW;

        if (historyIsShort) {
            console.warn(
                `Attention : seulement ${candles.length} bougies clôturées. L'EMA 200 est provisoire.`
            );
        }

        if (
            !Number.isFinite(ema50) ||
            !Number.isFinite(ema200) ||
            !Number.isFinite(rsi) ||
            !Number.isFinite(atr) ||
            atr <= 0
        ) {
            setText("signal-type", "EN ATTENTE");

            setText(
                "signal-reason",
                "Impossible de calculer tous les indicateurs."
            );

            setText("last-analysis", "Analyse incomplète");

            return;
        }

        // Le prix utilisé pour l'entrée est le prix actuel
        // s'il est disponible, sinon la dernière clôture H4.
        const entry = currentPrice || close;

        let type = null;
        let reason = "";

        // CONDITIONS D'ACHAT
        if (
            ema50 > ema200 &&
            close > ema50 &&
            rsi >= 50 &&
            rsi <= 70
        ) {
            type = "ACHAT";

            reason =
                "EMA 50 supérieure à EMA 200, prix au-dessus de l'EMA 50 et RSI favorable.";
        }

        // CONDITIONS DE VENTE
        else if (
            ema50 < ema200 &&
            close < ema50 &&
            rsi >= 30 &&
            rsi <= 50
        ) {
            type = "VENTE";

            reason =
                "EMA 50 inférieure à EMA 200, prix sous l'EMA 50 et RSI favorable.";
        }

        if (historyIsShort) {
            reason +=
                ` Attention : ${candles.length} bougies seulement ; l'EMA 200 est provisoire.`;
        }

        if (!type) {
            setText("signal-type", "PAS DE SIGNAL");

            setText(
                "signal-reason",
                `Les conditions d'achat ou de vente ne sont pas toutes réunies. Tendance : ${trend}. RSI : ${rsi.toFixed(2)}.` +
                (historyIsShort
                    ? ` Attention : l'EMA 200 est provisoire (${candles.length} bougies).`
                    : "")
            );

            setText("last-analysis", "Analyse terminée");

            setStatus("Connecté — analyse effectuée", true);

            return;
        }

        let sl;
        let tp;

        if (type === "ACHAT") {
            sl = entry - atr * SL_ATR_MULTIPLIER;
            tp = entry + atr * TP_ATR_MULTIPLIER;
        } else {
            sl = entry + atr * SL_ATR_MULTIPLIER;
            tp = entry - atr * TP_ATR_MULTIPLIER;
        }

        displaySignal(
            type,
            entry,
            sl,
            tp,
            trend,
            reason,
            rsi
        );

        setText("last-analysis", "Analyse terminée");

        setStatus("Connecté — analyse effectuée", true);

    } catch (error) {
        console.error("Erreur d'analyse :", error);

        setText("signal-type", "ERREUR");

        setText(
            "signal-reason",
            "Impossible de terminer l'analyse. Vérifie la connexion aux données Biquote."
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
    if (analysisTimer) {
        clearInterval(analysisTimer);
    }

    if (priceTimer) {
        clearInterval(priceTimer);
    }

    analyzeMarket();

    // Actualise le prix toutes les 15 secondes.
    priceTimer = setInterval(async () => {
        const success = await fetchPrice();

        if (!success) {
            setStatus("Erreur de récupération du prix", false);
        }
    }, PRICE_REFRESH_MS);

    // Relance l'analyse toutes les 60 secondes.
    analysisTimer = setInterval(() => {
        analyzeMarket();
    }, ANALYSIS_REFRESH_MS);
}

// ============================================
// 15. BOUTON ACTUALISER
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
