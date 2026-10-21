J’ai trouvé le problème dans ton code. Il y a une erreur dans la fonction ws.onclose : elle appelle setConnectionStatus(), alors que le reste du code utilise logStatus(). De plus, l’ancienne fonction de reconnexion est toujours présente après la fermeture de la nouvelle fonction.
Cela peut perturber la reconnexion.
Il faut également vérifier que Deriv accepte bien le symbole frxXAUUSD et que la connexion WebSocket fonctionne.
Je vais te préparer le fichier complet corrigé, mais avant, vérifie un point : ton site est-il hébergé sur GitHub Pages et accessible avec une adresse se terminant par github.io ?
