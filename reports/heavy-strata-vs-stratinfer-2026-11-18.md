# Test de charge lourde — Strata contre StratInfer avec NOEMA

Date : 18 novembre 2026

Machine : RTX 5090 32 Gio + RTX 4080 SUPER 16 Gio, Qwen3.8-Flash-Next, MOAI 1.0.15

## Verdict exécutif

**StratInfer reste le meilleur moteur par défaut sur cette machine pour la charge lourde.**
Sur 338 requêtes d'inférence appariées, il conserve exactement la qualité ciblée de
Strata et améliore le décodage, le préremplissage, la concurrence élevée, le contexte
long, la latence au premier token et l'efficacité énergétique.

Deux réserves demeurent : la reprise d'un contexte déjà chaud est 10,26 % plus lente et
le sampling live n'est déterministe dans aucun moteur. Les outils MCP/NOEMA sont fiables
à 100 % dans cette campagne, mais leur coût de schéma et leurs deux tours de modèle
imposent de les garder strictement opt-in.

La campagne NOEMA `campaign-89c5aca6-a497-4994-aed5-102eaeaa2901` est terminée. Après
deux revues ayant exigé les preuves de comparabilité, sécurité MCP et rollback, la revue
indépendante finale retourne **PASS à 0,89**, sans correction requise. Elle qualifie cette
batterie ciblée, pas l'endurance ni une disponibilité générale de production.

| Critère | Strata | StratInfer | Écart StratInfer | Verdict |
|---|---:|---:|---:|---|
| décodage fixe, 15 mesures | 86,913 tok/s | 93,907 tok/s | **+8,05 %** | gain apparié établi |
| préremplissage frais, 122K tokens | 3 617 tok/s | 4 152 tok/s | **+14,80 %** | gain très stable |
| concurrence 4 | 108,21 tok/s | 120,72 tok/s | **+11,56 %** | avantage net |
| concurrence 8 | 104,26 tok/s | 121,14 tok/s | **+16,19 %** | avantage net |
| p95 à concurrence 8 | 30,697 s | 26,035 s | **-15,19 %** | meilleure latence |
| TTFT médian | 642,8 ms | 568,0 ms | **-11,64 %** | meilleur |
| énergie médiane, 512 tokens | 1 177,46 J | 1 076,04 J | **-8,61 %** | meilleur |
| efficacité | 0,4348 tok/J | 0,4758 tok/J | **+9,43 %** | meilleur |
| qualité ciblée | 30/30 | 30/30 | égalité | aucune régression |
| reprise exacte, 158 452 tokens | 99,9823 % | 99,9823 % | égalité | exacte |
| temps de reprise chaude | 1 402,2 ms | 1 546,1 ms | **+10,26 %** | régression |
| déterminisme, 13 sorties | 12 divergences | 12 divergences | égalité | échec commun |

Le gain apparié de décodage global a un intervalle de confiance à 95 % de **+3,14 % à
+12,73 %**. Le préremplissage frais est encore plus net : **+13,49 % à +16,11 %**.

## Protocole lourd

Chaque moteur a reçu exactement la même batterie après activation MOAI et readiness Qwen :

1. cinq répétitions de trois charges fixes, code, prose et agent 32K ;
2. cinq prompts frais de 122K tokens réellement lus ;
3. cinq répétitions aux concurrences 1, 2, 4 et 8, pour 75 requêtes par moteur ;
4. une lecture froide et une reprise exacte de 158 452 tokens ;
5. trois répétitions de dix contrôles de qualité et contexte long ;
6. cinq générations streamées de 512 tokens avec puissance RTX 5090 ;
7. cinq sorties sérielles et huit sorties intercalées, plus 24 requêtes parasites,
   pour tester le déterminisme ;
8. sur StratInfer, 40 appels FastMCP/NOEMA mesurés et une charge NOEMA de 2 025 lectures,
   écritures, vérifications et rappels.

Cela représente **169 requêtes d'inférence par moteur**, 338 appariées, puis 40 appels
MCP mesurés. Aucun essai valide n'a été retiré, y compris les premiers essais de chauffe.

## Systèmes comparés

- Strata stable 0.1.45, port 11440, profil MOAI officiel ;
- StratInfer 0.1.54, révision moteur `51f355f`, build CUDA `sm_120`, port 11441 ;
- mêmes fichiers Qwen3.8-Flash-Next IQ3_S, contexte maximal 524 288, KV `k8v4`,
  résidence KV 65 536, cache expert 8 000, spéculation 4 et YaRN x2 ;
- StratInfer ajoute un cache hôte de 12 Gio, huit slots, la sauvegarde de sessions, le
  cache auxiliaire RTX 4080 plafonné à 4 Gio, les checkpoints asynchrones et dix outils
  MCP. Le test compare donc les deux déploiements complets, pas un kernel isolé.

Les identités et empreintes de référence sont conservées dans
[`data/strata-vs-stratinfer-2026-11-01/environment.json`](data/strata-vs-stratinfer-2026-11-01/environment.json).
Les workloads, nonces, paramètres et résultats requête par requête sont dans les JSON
bruts liés à la fin du rapport.

## Décodage fixe

| Charge | Strata moyenne | StratInfer moyenne | Gain | IC 95 % apparié |
|---|---:|---:|---:|---:|
| code | 95,16 tok/s | 106,54 tok/s | **+11,96 %** | +6,14 % à +17,77 % |
| prose | 89,86 tok/s | 98,42 tok/s | **+9,53 %** | +0,32 % à +19,14 % |
| agent long contexte | 75,72 tok/s | 76,76 tok/s | +1,37 % | -11,29 % à +15,52 % |
| ensemble | 86,913 tok/s | 93,907 tok/s | **+8,05 %** | +3,14 % à +12,73 % |

Le gain de l'agent 32K seul reste dans le bruit. Le bénéfice global vient surtout du
code et de la prose, tandis que le préremplissage long bénéficie davantage aux deux
moteurs que le décodage de cette charge agent.

## Préremplissage et contexte long

Le préremplissage de cinq prompts uniques de 122K tokens atteint 3 617,2 tok/s pour
Strata et 4 152,4 tok/s pour StratInfer, soit **+14,80 %**. Les coefficients de variation
restent faibles, 1,24 % et 1,40 %.

| Aiguille | Tokens réels | Strata | StratInfer | Écart |
|---|---:|---:|---:|---:|
| 2K | 2 309 | 2 631,6 ms | 2 480,0 ms | **-5,76 %** |
| 8K | 8 909 | 3 860,5 ms | 3 715,0 ms | **-3,77 %** |
| 32K | 35 310 | 11 291,5 ms | 10 197,6 ms | **-9,69 %** |
| 64K | 70 510 | 20 565,8 ms | 18 199,9 ms | **-11,50 %** |

Les 24 recherches d'aiguille réussissent. L'avantage de StratInfer augmente avec la
taille du contexte sur cette série.

## Concurrence

| Requêtes | Débit Strata | Débit StratInfer | Gain | p95 Strata | p95 StratInfer | Écart p95 |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 106,67 | 105,06 | -1,51 % | 5 542 ms | 5 235 ms | **-5,54 %** |
| 2 | 109,52 | 122,54 | **+11,89 %** | 7 818 ms | 7 059 ms | **-9,71 %** |
| 4 | 108,21 | 120,72 | **+11,56 %** | 15 173 ms | 12 725 ms | **-16,13 %** |
| 8 | 104,26 | 121,14 | **+16,19 %** | 30 697 ms | 26 035 ms | **-15,19 %** |

À concurrence 1, la médiane de débit est légèrement inférieure, mais la latence p95 est
meilleure et l'intervalle apparié traverse zéro. À concurrence 4 et 8, les intervalles
appariés sont entièrement positifs. StratInfer résiste donc mieux à la saturation.

## Reprise de session

Les deux moteurs réutilisent exactement 158 424 tokens sur 158 452. StratInfer réduit la
lecture froide de 44 400,1 ms à 38 219,2 ms, soit **-13,92 %**, mais la reprise chaude
passe de 1 402,2 ms à 1 546,1 ms, soit **+10,26 %**. Cette régression reste la priorité
d'optimisation principale des longues sessions.

## Énergie et mémoire GPU

| Mesure | Strata | StratInfer | Écart |
|---|---:|---:|---:|
| TTFT médian | 642,8 ms | 568,0 ms | **-11,64 %** |
| décodage médian | 113,2 tok/s | 129,2 tok/s | **+14,13 %** |
| temps total médian | 5 128,2 ms | 4 526,4 ms | **-11,74 %** |
| énergie carte | 1 177,46 J | 1 076,04 J | **-8,61 %** |
| tokens/joule | 0,4348 | 0,4758 | **+9,43 %** |
| puissance moyenne | 224,53 W | 231,65 W | +3,17 % |
| pic de puissance | 289,65 W | 323,71 W | +11,76 % |
| pic mémoire RTX 5090 | 29 799 MiB | 30 141 MiB | +1,15 % |

StratInfer économise de l'énergie parce qu'il termine plus vite, pas parce qu'il consomme
moins instantanément. Son pic électrique et son pic VRAM sont supérieurs.

## Qualité des résultats

Les deux moteurs obtiennent **30/30** : calcul, traçage JavaScript et Python, JSON strict,
priorité système et récupération exacte de contexte de 2K à 70,5K tokens. Cela démontre
l'absence de régression sur cette grille ciblée, pas une supériorité sémantique du modèle :
les deux moteurs utilisent les mêmes poids Qwen3.8-Flash-Next.

Le déterminisme live échoue encore dans les deux moteurs : une seule empreinte de sortie
sur treize correspond à la référence malgré une graine identique. Les tests, artefacts et
checkpoints durables restent donc indispensables aux agents de codage.
La cause exacte n'est pas démontrée ; l'hypothèse d'un effet de l'ordonnancement
asynchrone reste non vérifiée.

## MCP et NOEMA

Les quatre modes réussissent chacun **10/10** appels stricts :

| Mode | Médiane | p95 | Tokens prompt | Résultat |
|---|---:|---:|---:|---|
| sans MCP | 165,3 ms | 269,2 ms | 35 | 10/10 |
| schémas MCP annoncés | 1 775,2 ms | 1 871,1 ms | 1 231 | 10/10 |
| outil StratInfer | 2 756,6 ms | 3 064,0 ms | 1 566 | 10/10 |
| outil NOEMA | 3 233,8 ms | 3 800,7 ms | 1 821 | 10/10 |

L'exécution réelle de l'outil reste à 15 ms médian. Le coût vient du schéma de dix outils
et des tours de modèle. MCP doit rester désactivé sur les requêtes ordinaires.

FastMCP n'est pas entièrement read-only : `memory_remember` écrit dans une base SQLite
dont le chemin est fixé au démarrage du processus stdio, avec une limite de 32 Gio. Un
test isolé sur base temporaire a validé les six outils, l'écriture/rappel, le rejet d'une
évasion de chemin et dix lectures Git. Il n'existe pas d'écoute réseau MCP indépendante ;
l'autorisation applicative reste l'option explicite `strata_mcp` de la requête.

Sous charge de contrôle, NOEMA atteint 3 844,7 lectures de santé/s, 69 checkpoints/s et
67,4 écritures mémoire/s. Les médianes sont 15,43 ms pour un checkpoint et 28,51 ms pour
un rappel hybride ; la chaîne d'événements reste valide et 25 mutations non autorisées
sont rejetées.

## Défaut trouvé et corrigé

La première activation Strata a rendu la main après 30,1 s alors que MOAI indiquait
encore `loaded=false`, `qwen.ready=false` et que le port 11440 refusait les connexions.
Le premier appel a donc produit `fetch failed` et a été exclu avant toute mesure.

NOEMA attend désormais simultanément : moteur sélectionné et actif, `switching=false`,
`loaded=true`, Qwen prêt et non en chargement. Après redémarrage de NOEMA, la bascule vers
StratInfer a attendu 50,3 s et n'a rendu la main qu'une fois le moteur utilisable. Un test
simule trois lectures de santé avant readiness. Les PID ASR et TTS sont restés identiques.

Une seconde bascule corrigée a ensuite validé Strata en 30,753 s avec `/health=ok`, puis
StratInfer en 49,720 s, tous deux avec `loaded=true` et Qwen prêt. Un test supplémentaire
force un Qwen qui ne devient jamais prêt et vérifie que l'activation expire en erreur au
lieu de produire un faux succès. La suite complète atteint désormais 25/25 tests NOEMA
et 50/50 tests combinés.

Avant rollback, les contenus sales concernés et leurs hashes sont préservés sous
`E:\Data\NOEMA\rollback\campaign-89c5aca6-a497-4994-aed5-102eaeaa2901\readiness-fix`.
Restaurer uniquement les deux fichiers depuis la révision Git connue
`fb70adb8a22aec03de95304e0163802937e9e5ca` avec `git restore --source=<sha> --worktree --`
afin de conserver tous les autres changements, puis redémarrer NOEMA avec
`scripts/stop-noema.ps1` puis `scripts/start-noema.ps1`, et imposer manuellement la porte
`selected/active`, `switching=false`, `loaded=true`, Qwen prêt avant toute inférence.
Vérifier ensuite les deux ports, les PID ASR/TTS et terminer sur StratInfer.

## Recommandation

- conserver StratInfer comme moteur MOAI par défaut pour le développement, le contexte
  long et les charges multi-agents ;
- conserver Strata comme rollback stable ;
- garder MCP/NOEMA opt-in par requête ;
- optimiser la reprise chaude de cache avant de revendiquer un gain sur tous les chemins ;
- ne pas promettre de déterminisme bit à bit tant que le test 13/13 n'est pas passé ;
- poursuivre avec une endurance 24 h, une pression SSD progressive et une grille qualité
  externe plus large avant une qualification de production.

## État final

StratInfer est restauré actif et prêt. ASR et TTS sont prêts sur la RTX 4080, les deux
serveurs MCP sont `ready`, dix outils sont disponibles et aucun profil `agent-max` n'est
laissé actif.

## Données brutes

- [résumé calculé](data/heavy-strata-vs-stratinfer-2026-11-18/summary.json)
- [bascule et correction readiness](data/heavy-strata-vs-stratinfer-2026-11-18/switches.json)
- [bras Strata](data/heavy-strata-vs-stratinfer-2026-11-18/strata/)
- [bras StratInfer](data/heavy-strata-vs-stratinfer-2026-11-18/stratinfer/)
- [FastMCP et NOEMA](data/heavy-strata-vs-stratinfer-2026-11-18/stratinfer-mcp/)
- [charge du contrôle NOEMA](data/heavy-strata-vs-stratinfer-2026-11-18/noema-control/)
