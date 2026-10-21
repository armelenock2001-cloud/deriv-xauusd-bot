const wsUrl = "wss://green.derivws.com/websockets/v3?app_id=1089";
let ws;
const symbol = "frxXAUUSD"; 

// Jeton API personnel intégré
const apiToken = "Pat_064de0775d182d7c5acfcc234bebfec26bf0ef9f42b6867046dacb23d30a1572"; 

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
        logStatus("Connecté. Authentification du compte...");
        
        // Authentification avec ton compte personnel
        ws.send(JSON.stringify({
            authorize: apiToken
        }));
    };

    ws.onmessage = function(event) {
        const data = JSON.parse(event.data);
        console.log("Message reçu de Deriv :", data);

        if (data.error) {
            logStatus("Erreur : " + data.error.message);
            return;
        }

        // Une fois l'autorisation réussie, on s'abonne aux prix de l'or
        if (data.msg_type === "authorize") {
            logStatus("Compte connecté (" + data.authorize.email + "). Abonnement...", true);
            ws.send(JSON.stringify({
                ticks: symbol,
                subscribe: 1
            }));
        }
        
        // Réception des prix en temps réel
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

    ws.onclose =
        
