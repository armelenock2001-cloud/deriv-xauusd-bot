const wsUrl = "wss://ws.derivws.com/websockets/v3?app_id=1089";
let ws;
const symbol = "XAUUSD"; // Symbole corrigé pour la connexion à l'or sur Deriv

let priceHistory = [];
const maxHistoryLength = 50; // Garde les 50 derniers prix pour l'analyse

function connectDeriv() {
    ws = new WebSocket(wsUrl);

    ws.onopen = function() {
        document.getElementById("connection-status").textContent = "Connecté à Deriv";
        document.getElementById("connection-status").className = "status connected";
        
        // S'abonner aux ticks en temps réel pour l'or
        ws.send(JSON.stringify({
            ticks: symbol,
            subscribe: 1
        }));
    };

    ws.onmessage = function(event) {
        const data = JSON.parse(event.data);
        
        if (data.msg_type === "tick") {
            const tick = data.tick;
            const price = tick.quote;
            const time = new Date(tick.epoch * 1000).toLocaleTimeString();

            // Mettre à jour l'affichage du prix
            document.getElementById("current-price").textContent = price.toFixed(2);
            document.getElementById("last-update").textContent = time;

            // Ajouter à l'historique local pour analyse
            priceHistory.push(price);
            if (priceHistory.length > maxHistoryLength) {
                priceHistory.shift();
            }

            // Lancer l'analyse automatique
            analyzeMarket();
        }
    };

    ws.onclose = function() {
        document.getElementById("connection-status").textContent = "Déconnecté. Reconnexion...";
        document.getElementById("connection-status").className = "status disconnected";
        setTimeout(connectDeriv, 5000); // Tentative de reconnexion après 5 secondes
    };
}

function analyzeMarket() {
    if (priceHistory.length < 10) return; // Pas assez de données

    // Logique simple de tendance basée sur les mouvements récents
    const recentPrices = priceHistory.slice(-10);
    const firstPrice = recentPrices[0];
    const lastPrice = recentPrices[recentPrices.length - 1];

    let tendance = "Neutre / Consolidation";
    if (lastPrice > firstPrice) {
        tendance = "Haussière (Bullish)";
        document.getElementById("market-tendance").className = "value";
        document.getElementById("market-tendance").style.color = "#27ae60";
    } else if (lastPrice < firstPrice) {
        tendance = "Baissière (Bearish)";
        document.getElementById("market-tendance").className = "value";
        document.getElementById("market-tendance").style.color = "#c0392b";
    }
    document.getElementById("market-tendance").textContent = tendance;

    // Condition de génération de signal
    const diff = lastPrice - firstPrice;
    if (Math.abs(diff) > 0.5) { // Seuil de déclenchement
        const type = diff > 0 ? "BUY" : "SELL";
        const entry = lastPrice;
        const sl = type === "BUY" ? entry - 2.5 : entry + 2.5;
        const tp = type === "BUY" ? entry + 5.0 : entry - 5.0;
        
        triggerSignal(type, entry, sl, tp, tendance, "Momentum fort détecté sur les derniers ticks.");
    }
}

let lastSignalType = null;
function triggerSignal(type, entry, sl, tp, tendance, reason) {
    if (type === lastSignalType) return;
    lastSignalType = type;

    const time = new Date().toLocaleTimeString();

    // Affichage UI
    const badge = document.getElementById("signal-type");
    badge.textContent = type;
    badge.className = `badge ${type.toLowerCase()}`;

    document.getElementById("signal-entry").textContent = entry.toFixed(2);
    document.getElementById("signal-sl").textContent = sl.toFixed(2);
    document.getElementById("signal-tp").textContent = tp.toFixed(2);
    document.getElementById("signal-conf").textContent = "78%";
    document.getElementById("signal-reason").textContent = reason;

    // Ajouter à l'historique
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

    // Notification navigateur si supporté
    if (Notification.permission === "granted") {
        new
            
