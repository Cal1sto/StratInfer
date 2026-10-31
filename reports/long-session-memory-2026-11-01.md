# Rapport mémoire longue session — 1 novembre 2026

## Objectif

La modification vise les longues sessions de développement qui alternent plusieurs
spécialités sans perdre l'objectif principal. Elle ajoute trois niveaux : cache K/V
exact sur la RTX 4080 SUPER, sessions exactes bornées à 32 Gio sur SSD, et contexte
canonique soutenu par une matrice de rappel persistante.

Le moteur principal actif sur la RTX 5090 n'a pas été arrêté. La validation a utilisé
un build sm120 séparé et des tests de composant. Ce rapport ne transforme donc pas un
microbenchmark en gain de débit complet du modèle.

## Matériel et build

- source : RTX 5090, 32 607 Mio, CUDA device 0 ;
- cache : RTX 4080 SUPER, 16 376 Mio, CUDA device 1 ;
- pilote : 610.88 ; CUDA 13.1.115 ;
- Strata : commit `870aedd` avec overlay StratInfer ;
- compilation : `CMAKE_CUDA_ARCHITECTURES=120-real` ;
- modèle actif non redémarré pendant toute la campagne.

## Résultats

| Contrôle | Résultat | Verdict |
|---|---:|---|
| application de l'overlay sur Strata vierge | propre | passé |
| snapshot standard | 4 195 contrôles, 0 échec, 0,68 s | passé |
| snapshot exact RTX 5090 vers RTX 4080 | 4 195 contrôles, 0 échec, 0,82 s | passé |
| repli hôte quand le budget auxiliaire est insuffisant | 4 195 contrôles, 0 échec, 0,80 s | passé |
| tests Node mémoire/orchestration | 9/9 | passé |
| copie 5090 vers 4080, 512 Mio x5 | 10,836 Gio/s | validée |
| copie 4080 vers 5090, 512 Mio x5 | 11,460 Gio/s | validée |
| indexation matricielle, 2 000 entrées | 3 002 entrées/s | composant |
| rappel, 100 requêtes | 13,792 ms de moyenne | composant |
| rappel top-5 synthétique à clé unique | 100 % | passé sur ce corpus uniquement |

Les deux GPU déclarent `cudaDeviceCanAccessPeer=0`. `cudaMemcpyPeerAsync` fonctionne et
valide les octets, mais le pilote utilise donc vraisemblablement un chemin PCIe mis en
scène plutôt qu'un accès direct de type NVLink. Le résultat mesuré reste supérieur à
10 Gio/s dans les deux sens, avec un motif distinct validé après chaque direction.

## Effet attendu

Les snapshots réels observés avant cette modification faisaient environ 2,2 à 3,44
Gio. Ils tiennent dans le budget auxiliaire de 4 Gio et peuvent donc rester sur la RTX
4080. À 10,836 Gio/s, un transfert brut de 3,44 Gio représente environ 318 ms ; c'est
une projection calculée, pas une latence de restauration complète mesurée.

Un snapshot supérieur à 4 Gio ne provoque pas d'échec : Strata conserve son image hôte
et reprend le chemin existant. Le budget laisse aussi 1,5 Gio de marge VRAM imposée par
Strata sur la carte auxiliaire.

Le SSD conserve un fichier de session exact par spécialiste. LRU supprime d'abord les
spécialistes non épinglés si le projet dépasse 32 Gio ou si le volume descend sous 4
Gio libres. Le contexte canonique, la matrice et les transcriptions ne sont jamais
supprimés par cette LRU. Le test de quota utilise une échelle réduite ; il valide la
politique, pas une écriture physique de 32 Gio.

## Prévention des oublis

Le rappel seul n'est jamais chargé de préserver l'objectif principal. `core.json`
contient l'objectif, les contraintes, invariants, décisions et résultats acceptés ; il
est injecté intégralement à chaque rôle. La matrice 512 dimensions ne sélectionne que
les souvenirs de soutien. Une réponse de modèle peut enrichir le journal, mais elle ne
modifie pas silencieusement le noyau canonique.

Les rôles validés sont `architect`, `implementer`, `reviewer`, `tester` et
`documenter`. Le test de redémarrage rouvre le noyau, la matrice et une transcription
dans une nouvelle instance. Le test HTTP couvre `/v1/chat/completions` et les endpoints
natifs `/slots/0?action=save|restore`.

## Limites et prochaine porte

- aucun A/B complet Qwen3.8-Flash-Next avec et sans cache auxiliaire n'a été lancé ;
- aucune trace continue de 24 heures n'a encore validé l'absence d'oubli en charge ;
- l'orchestrateur est séquentiel, car les sessions disque Strata sont incompatibles
  avec les slots parallèles ;
- le cache ne dépasse pas la fenêtre de contexte du modèle ;
- la matrice est lexicale et déterministe, pas une mémoire sémantique apprise.

Le candidat C11 est donc **validé hors ligne, non déployé**. Le passage en production
demande un serveur dédié ou une fenêtre de bascule, puis une trace de 24 heures avec :
zéro invariant perdu, zéro restauration invalide, stockage inférieur à 32 Gio et
absence de pression sur la RTX 4080.

## Données

- [`peer-cache.json`](data/long-session-2026-11-01/peer-cache.json)
- [`context-matrix.json`](data/long-session-2026-11-01/context-matrix.json)
- [`validation.json`](data/long-session-2026-11-01/validation.json)
