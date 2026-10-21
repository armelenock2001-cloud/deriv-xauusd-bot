let signalTimer = null;
let currentSignal = null;

// Initialisation au chargement de la page pour récupérer les données Biquote
window.onload = function() {
    recupererPrixBiquote();
    // Actualisation automatique du flux Biquote toutes les minutes
    setInterval(recupererPrixBiquote, 60000);
};

// Fonction de récupération des données depuis Biquote
function recupererPrixBiquote() {
    // Connexion ou requête vers l'API/WebSocket de Biquote pour l'or (XAU/USD)
    // (Exemple de structure pour intégrer le flux Biquote sans bloquer l'interface)
    console.log("Synchronisation des prix XAU/USD avec Biquote...");
    
    // Si tu utilises un WebSocket Biquote, tu intègres ta connexion ici.
    // Par défaut, on s'assure que l'interface affiche l'état d'attente du signal H4 si aucun signal n'est actif.
    if (!currentSignal) {
        document.getElementById("signal-container").innerHTML = `
            <p style='color: #2ecc71;'>Flux Biquote Connecté (XAU/USD)</p>
            <p>En attente de la prochaine configuration H4...</p>
        `;
    }
}

// Fonction déclenchée lors de l'arrivée d'un signal H4
function genererSignalOrH4(typeSignal, prixCible, sl, tp) {
    const dureeValidite = 4 * 60 * 60; // 4 heures en secondes (H4)
    let tempsRestant = dureeValidite;

    currentSignal = {
        type: typeSignal, // 'BUY' ou 'SELL'
        price: prixCible,
        stopLoss: sl,
        takeProfit: tp,
        actif: 'XAU/USD'
    };

    afficherInterfaceSignal(currentSignal, tempsRestant);

    // Lancer le compte à rebours H4
    clearInterval(signalTimer);
    signalTimer = setInterval(() => {
        tempsRestant--;
        mettreAJourAffichageTemps(tempsRestant);

        if (tempsRestant <= 0) {
            clearInterval(signalTimer);
            annulerSignal();
        }
    }, 1000);
}

// Met à jour l'affichage visuel du signal H4
function afficherInterfaceSignal(signal, tempsRestant) {
    const heures = Math.floor(tempsRestant / 3600);
    const minutes = Math.floor((tempsRestant % 3600) / 60);
    const secondes = tempsRestant % 60;
    const container = document.getElementById("signal-container");
    
    container.innerHTML = `
        <h3 style="color: ${signal.type === 'BUY' ? '#27ae60' : '#e74c3c'};">
            Signal H4 (Biquote) : ${signal.type}
        </h3>
        <p>Entrée : <b>${signal.price}</b></p>
        <p style="color: #e74c3c; font-size: 0.9rem;">Stop Loss : <b>${signal.stopLoss}</b></p>
        <p style="color: #27ae60; font-size: 0.9rem;">Take Profit : <b>${signal.takeProfit}</b></p>
        <p style="font-size: 1.1rem; color: #f1c40f; margin-top: 10px;">
            <strong>Expiration : ${heures}h ${minutes}m ${secondes}s</strong>
        </p>
    `;
}

function mettreAJourAffichageTemps(tempsRestant) {
    if (currentSignal) {
        afficherInterfaceSignal(currentSignal, tempsRestant);
    }
}

// Annule automatiquement le signal si le délai H4 expire
function annulerSignal() {
    currentSignal = null;
    document.getElementById("signal-container").innerHTML = `
        <p style='color: #e74c3c;'>Signal H4 expiré.</p>
        <p>En attente du prochain signal Biquote...</p>
    `;
}

// Simulation d'un signal H4 basé sur les cours Biquote
function simulerArriveeSignalH4() {
    const prixBiquoteFictif = (4118.00).toFixed(2);
    const slFictif = (4158.00).toFixed(2); // Stop Loss large H4
    const tpFictif = (4038.00).toFixed(2); // Take Profit large H4
    
    genererSignalOrH4('SELL', prixBiquoteFictif, slFictif, tpFictif);
}

// Exécution de l'ordre sur Deriv en accord avec le signal H4
function validerEtExecuterPosition() {
    if (!currentSignal) {
        alert("Aucun signal H4 actif !");
        return;
    }

    const ws = new WebSocket('wss://ws.derivws.com/websockets/v3?app_id=1089');

    ws.onopen = function() {
        const ordreAchat = {
            "buy": 1,
            "price": currentSignal.price,
            "parameters": {
                "amount": 0.01, // Lot sécurisé pour tenir la distance en H4
                "basis": "stake",
                "currency": "USD",
                "symbol": "frxXAUUSD",
                "duration": 4,
                "duration_unit": "h", // Durée 4 heures (H4)
                "contract_type": currentSignal.type === 'BUY' ? "CALL" : "PUT"
            }
        };
        
        ws.send(JSON.stringify(ordreAchat));
    };

    ws.onmessage = function(event) {
        const data = JSON.parse(event.data);
        
        if (data.msg_type === "buy") {
            alert("Succès ! Position H4 ouverte sur Deriv. ID : " + data.buy.contract_id);
            clearInterval(signalTimer);
            annulerSignal();
            ws.close();
        } else if (data.error) {
            alert("Erreur Deriv : " + data.error.message);
            ws.close();
        }
    };

    ws.onerror = function(error) {
        alert("Erreur de connexion WebSocket avec Deriv.");
        ws.close();
    };
    }
