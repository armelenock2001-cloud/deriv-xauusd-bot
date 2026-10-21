let signalTimer = null;
let currentSignal = null;

// Fonction déclenchée lors de l'arrivée d'un signal sur l'or (XAU/USD)
function genererSignalOr(typeSignal, prixCible) {
    const dureeValidite = 5 * 60; // 5 minutes en secondes
    let tempsRestant = dureeValidite;

    currentSignal = {
        type: typeSignal, // 'BUY' (CALL) ou 'SELL' (PUT)
        price: prixCible,
        actif: 'XAU/USD'
    };

    afficherInterfaceSignal(currentSignal, tempsRestant);

    // Lancer le compte à rebours
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

// Met à jour l'affichage visuel du signal et du temps restant
function afficherInterfaceSignal(signal, tempsRestant) {
    const minutes = Math.floor(tempsRestant / 60);
    const secondes = tempsRestant % 60;
    const container = document.getElementById("signal-container");
    
    container.innerHTML = `
        <h3 style="color: ${signal.type === 'BUY' ? '#27ae60' : '#e74c3c'};">
            Signal Actif : ${signal.type} sur Or (XAU/USD)
        </h3>
        <p>Prix cible : <b>${signal.price}</b></p>
        <p style="font-size: 1.2rem; color: #f1c40f;">
            <strong>Temps pour valider : ${minutes}m ${secondes < 10 ? '0' : ''}${secondes}s</strong>
        </p>
    `;
}

function mettreAJourAffichageTemps(tempsRestant) {
    if (currentSignal) {
        afficherInterfaceSignal(currentSignal, tempsRestant);
    }
}

// Annule automatiquement le signal si le temps est écoulé
function annulerSignal() {
    currentSignal = null;
    document.getElementById("signal-container").innerHTML = `
        <p style='color: #e74c3c;'>Signal expiré (délai de 5 min dépassé).</p>
        <p>En attente d'une nouvelle opportunité...</p>
    `;
}

// Fonction de test pour simuler un signal manuellement depuis ton téléphone
function simulerArriveeSignal() {
    const prixFictif = (2350 + Math.random() * 5).toFixed(2);
    genererSignalOr('BUY', prixFictif);
}

// Exécute la position sur Deriv lorsque tu cliques sur le bouton
function validerEtExecuterPosition() {
    if (!currentSignal) {
        alert("Aucun signal actif ou signal expiré ! Attends le prochain signal.");
        return;
    }

    // Connexion au WebSocket de l'API Deriv (app_id 1089 est l'ID de test public de Deriv)
    const ws = new WebSocket('wss://ws.derivws.com/websockets/v3?app_id=1089');

    ws.onopen = function() {
        const ordreAchat = {
            "buy": 1,
            "price": currentSignal.price,
            "parameters": {
                "amount": 1, // Montant de la mise en USD
                "basis": "stake",
                "currency": "USD",
                "symbol": "frxXAUUSD", // Code officiel de l'or sur Deriv
                "duration": 5,
                "duration_unit": "m", // Contrat d'une durée de 5 minutes
                "contract_type": currentSignal.type === 'BUY' ? "CALL" : "PUT"
            }
        };
        
        ws.send(JSON.stringify(ordreAchat));
    };

    ws.onmessage = function(event) {
        const data = JSON.parse(event.data);
        
        if (data.msg_type === "buy") {
            alert("Succès ! Position prise. ID du contrat : " + data.buy.contract_id);
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
