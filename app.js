const wsUrl = "wss://ws.derivws.com/websockets/v3?app_id=1089";
let ws;
const symbol = "frxXAUUSD"; // Test avec le format Forex officiel de Deriv

let priceHistory = [];
const maxHistoryLength = 50;

function logStatus(message, isConnected = false) {
    const statusEl = document.getElementById("connection-status");
    statusEl.textContent = message;
    statusEl.className = isConnected ? "status connected" : "status disconnected";
    console.log(message);
}

function connectDeriv() {
    logStatus("Connexion en cours...");
    ws = new WebSocket(wsUrl);

    ws.onopen = function() {
        logStatus("Connecté à Deriv. Abonnement...", true);
        
        // S'abonner aux ticks en temps réel
        ws.send(JSON.stringify({
            ticks: symbol,
            subscribe: 1
        }));
    };

    ws.onmessage = function(event) {
        const data = JSON.parse(event.data);
        console.log("Message reçu de Deriv :", data);

        // Gestion des erreurs renvoyées par l'API
        if (data.error) {
            logStatus("Erreur API : " + data.error.message);
            return;
        }
        
        if (data.msg_type === "tick") {
            const tick = data.tick;
            const price = tick.quote;
            const time = new Date(tick.epoch * 1000).toLocaleTimeString();

            document.getElementById("current-price").textContent = price.toFixed(2);
            document.getElementById("last-update").textContent = time;

            priceHistory.push(price);
            if (priceHistory.length > maxHistoryLength) {
                priceHistory.shift();
            }

            analyzeMarket();
        }
    };

    ws.onerror = function(error) {
        logStatus("Erreur WebSocket");
        console.error("WebSocket Error: ", error);
    };

    ws.onclose = function() {
        logStatus("Déconnecté. Nouvelle tentative...");
        setTimeout(connectDeriv, 5000);
    };
}

function analyzeMarket() {
    if (priceHistory.length < 10) return;

    const recentPrices = priceHistory.slice(-10);
    const firstPrice = recentPrices[0];
    const lastPrice = recentPrices[recentPrices.length - 1];

    let tendance = "Neutre / Consolidation";
    if (lastPrice > firstPrice) {
        tendance = "Haussière (Bullish)";
        document.getElementById("market-tendance").style.color = "#27ae60";
    } else if (lastPrice < firstPrice) {
        tendance = "Baissière (Bearish)";
        document.getElementById("market-tendance").style.color = "#c0392b";
    }
    document.getElementById("market-tendance").textContent = tendance;

    const diff = lastPrice - firstPrice;
    if (Math.abs(diff) > 0.05) {
        const type = diff > 0 ? "BUY" : "SELL";
        const entry = lastPrice;
        const sl = type === "BUY" ? entry - 1.5 : entry + 1.5;
        const tp = type === "BUY" ? entry + 3.0 : entry - 3.0;
        
        triggerSignal(type, entry, sl, tp, tendance, "Variation de prix détectée.");
    }
}

let lastSignalType = null;
function triggerSignal(type, entry, sl, tp, tendance, reason) {
    if (type === lastSignalType) return;
    lastSignalType = type;

    const time = new Date().toLocaleTimeString();

    const badge = document.getElementById("signal-type");
    badge.textContent = type;
    badge.className = `badge ${type.toLowerCase()}`;

    document.getElementById("signal-entry").textContent = entry.toFixed(2);
    document.getElementById("signal-sl").textContent = sl.toFixed(2);
    document.getElementById("signal-tp").textContent = tp.toFixed(2);
    document.getElementById("signal-conf").textContent = "80%";
    document.getElementById("signal-reason").textContent = reason;

    const tbody = document.querySelector("#history-table tbody");
    const row = document.createElement("tr");
    row.innerHTML = `
        <td>${time}</td>
        <td><span class="badge ${type.toLowerCase()}">${type}</span></td>
        <td>${entry.toFixed(2)}</td>
        <td>SL: ${sl.toFixed(2)} / TP: ${tp.toFixed(2)}</td>
        <td>${tendance}</td>
    `;
    tbody.prepend(row);
}

window.onload = connectDeriv;
