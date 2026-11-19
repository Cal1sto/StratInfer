# Comparatif approfondi — Strata stable contre StratInfer

Date : 1er novembre 2026

Machine : RTX 5090 + RTX 4080 SUPER, i9-14900K, 127,7 Gio de RAM

Statut : campagne live terminée, StratInfer remis actif dans MOAI

## Verdict exécutif

**StratInfer est le meilleur choix live sur cette machine.** Il conserve la même réussite
fonctionnelle que Strata stable et améliore tous les chemins de calcul froid ou concurrent
mesurés. La reprise d'un contexte déjà mis en cache est la seule régression de performance
observée. Le déterminisme live reste défaillant dans les deux moteurs.

| Critère | Strata stable | StratInfer | Écart StratInfer | Verdict |
|---|---:|---:|---:|---|
| Décodage fixe, moyenne de 15 mesures | 106,56 tok/s | 116,35 tok/s | **+9,19 %** | gain établi sur cette campagne |
| Préremplissage frais, environ 61K tokens | 4 617,8 tok/s | 5 062,8 tok/s | **+9,64 %** | gain net et stable |
| Débit concurrent, 1 à 8 requêtes | 122,36–124,61 tok/s | 143,23–147,47 tok/s | **+16,77 % à +20,45 %** | avantage net |
| Latence p95 concurrente | 3,07–16,92 s | 2,70–14,41 s | **-12,29 % à -17,66 %** | avantage net |
| TTFT médian, premier token généré | 467,2 ms | 428,9 ms | **-8,20 %** | meilleur |
| Énergie médiane, sortie de 512 tokens | 1 025,63 J | 974,44 J | **-4,99 %** | meilleur |
| Efficacité énergétique | 0,4992 tok/J | 0,5254 tok/J | **+5,25 %** | meilleur |
| Qualité déterministe | 20/20 | 20/20 | égalité | aucune régression détectée |
| Aiguilles de 2,3K à 70,5K tokens | 8/8 | 8/8 | égalité | contexte long validé |
| Reprise exacte de 101 453 tokens | 99,9724 % | 99,9724 % | égalité | exacte dans les deux |
| Temps de reprise du prompt | 792,8 ms | 843,7 ms | **+6,42 %** | régression StratInfer |
| Déterminisme live, 13 exécutions | 12 divergences | 12 divergences | égalité | échec dans les deux |
| Requêtes officielles sans erreur | 159/159 | 159/159 | égalité | fiabilité API validée |

L'intervalle de confiance apparié à 95 % du gain moyen de décodage fixe est
**[+5,60 % ; +12,26 %]**. Celui du préremplissage frais est
**[+8,71 % ; +10,56 %]**. Ces deux signaux dépassent la bande de bruit historique de
plus ou moins 3 % utilisée par le projet.

## Ce qui est comparé

Il s'agit d'un comparatif des **deux moteurs réellement déployés**, pas d'un A/B isolant
une seule ligne de code :

- Strata stable `0.1.45`, port `11440` ;
- StratInfer `0.1.54`, révision `51f355f`, build CUDA `sm_120`, port `11441` ;
- même Qwen3.8-Flash-Next IQ3_S et mêmes fichiers GGUF ;
- même contexte maximal de 524 288 tokens, KV `k8v4`, résidence KV 65 536,
  cache expert, MTP, YaRN, cache conversation 8 Gio et huit slots ;
- StratInfer ajoute la sauvegarde/récupération de session, les checkpoints asynchrones
  et le cache auxiliaire RTX 4080 plafonné à 4 Gio.

Les empreintes binaires, le matériel et les différences de profil sont conservés dans
[`environment.json`](data/strata-vs-stratinfer-2026-11-01/environment.json).

## Protocole

1. Bascule transactionnelle MOAI vers chaque moteur, canary de santé et contrôle des PID
   Qwen3-ASR/Qwen3-TTS sur RTX 4080.
2. Cinq répétitions de trois charges fixes : code, prose et agent long contexte.
3. Cinq préremplissages uniques demandant 32K tokens estimés, soit environ 61K tokens
   réellement tokenisés.
4. Cinq répétitions à concurrence 1, 2, 4 et 8, 256 tokens par requête, soit 75 requêtes
   par moteur.
5. Reprise froide puis exacte d'un prompt de 101 453 tokens.
6. Deux répétitions de dix contrôles déterministes : raisonnement, code, priorité
   d'instructions et quatre profondeurs de contexte. Un nonce différent par essai élimine
   la réutilisation accidentelle du cache.
7. Cinq générations streamées de 512 tokens avec échantillonnage de la puissance RTX 5090.
8. Treize observations de déterminisme : cinq sérielles et huit intercalées avec trois
   requêtes concurrentes parasites.
9. Microbenchmarks séparés du transfert RTX 5090/RTX 4080 et de la mémoire matricielle.

Les gains appariés associent le même essai et la même charge. Aucun meilleur essai n'est
sélectionné. Les p95 de concurrence sont ceux publiés par le harnais ; les médianes sont
préférées lorsque le premier essai contient un coût de chauffe.

## Décodage fixe

| Charge | Strata moyenne | StratInfer moyenne | Gain | IC 95 % apparié | CV Strata | CV StratInfer |
|---|---:|---:|---:|---:|---:|---:|
| `code-8k` | 117,72 tok/s | 133,10 tok/s | **+13,07 %** | +6,83 % à +18,92 % | 8,79 % | 12,07 % |
| `prose-2k` | 108,18 tok/s | 117,02 tok/s | **+8,17 %** | +0,40 % à +16,37 % | 4,50 % | 2,60 % |
| `agent-32k` | 93,78 tok/s | 98,94 tok/s | **+5,50 %** | -0,95 % à +12,04 % | 1,36 % | 4,18 % |
| Ensemble | 106,56 tok/s | 116,35 tok/s | **+9,19 %** | +5,60 % à +12,26 % | 11,17 % | 14,63 % |

Le cas agent seul reste statistiquement incertain avec seulement cinq répétitions, mais
les quinze paires réunies donnent un avantage positif. StratInfer présente davantage de
variance sur le code ; il faut donc conserver les médianes et surveiller les longues
sessions plutôt que conclure à partir du maximum de 161,5 tok/s.

## Préremplissage frais

| Mesure | Strata | StratInfer | Écart |
|---|---:|---:|---:|
| Moyenne, cinq prompts | 4 617,8 tok/s | 5 062,8 tok/s | **+9,64 %** |
| Médiane | 4 609 tok/s | 5 049 tok/s | **+9,55 %** |
| Minimum–maximum | 4 571–4 697 | 5 006–5 160 | — |
| Coefficient de variation | 1,05 % | 1,17 % | — |

L'intervalle apparié à 95 % est de **+8,71 % à +10,56 %**. C'est le résultat le plus
stable de la campagne.

## Concurrence

| Requêtes | Débit Strata | Débit StratInfer | Gain | p95 Strata | p95 StratInfer | Écart p95 |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 122,36 tok/s | 143,23 tok/s | **+17,06 %** | 3 074,6 ms | 2 696,6 ms | **-12,29 %** |
| 2 | 122,43 tok/s | 147,47 tok/s | **+20,45 %** | 4 296,4 ms | 3 537,6 ms | **-17,66 %** |
| 4 | 123,98 tok/s | 145,42 tok/s | **+17,29 %** | 8 606,0 ms | 7 232,4 ms | **-15,96 %** |
| 8 | 124,61 tok/s | 145,51 tok/s | **+16,77 %** | 16 916,9 ms | 14 414,8 ms | **-14,79 %** |

Le meilleur point d'exploitation est ici la concurrence 2 : le débit monte à
147,47 tok/s sans la croissance de latence des lots 4 et 8. StratInfer reste cependant
devant à chaque niveau.

## Long contexte et qualité

Les deux moteurs réussissent **20/20** contrôles, dont **8/8** recherches d'aiguille.

| Contexte réel | Strata, latence moyenne | StratInfer, latence moyenne | Écart |
|---:|---:|---:|---:|
| 2 309 tokens | 1 989,95 ms | 1 883,95 ms | **-5,33 %** |
| 8 909 tokens | 3 116,60 ms | 2 913,60 ms | **-6,51 %** |
| 35 310 tokens | 8 679,65 ms | 7 901,35 ms | **-8,97 %** |
| 70 510 tokens | 15 435,20 ms | 14 082,60 ms | **-8,76 %** |

Ce test couvre la récupération exacte d'informations, le traçage de code, le calcul,
le JSON strict et la priorité système. Il ne remplace pas HumanEval, SWE-bench ni une
évaluation humaine de grands correctifs logiciels. Deux répétitions par profondeur
suffisent à détecter une régression grossière, pas à établir une distribution étroite.

## Reprise exacte

| Mesure | Strata | StratInfer | Écart StratInfer |
|---|---:|---:|---:|
| Prompt total | 101 453 | 101 453 | identique |
| Tokens réutilisés | 101 425 | 101 425 | identique |
| Taux exact | 99,9724 % | 99,9724 % | identique |
| Préremplissage froid | 21 553,4 ms | 19 522,8 ms | **-9,42 %** |
| Prompt repris | 792,8 ms | 843,7 ms | **+6,42 %** |
| Accélération froid/repris | 27,19x | 23,14x | inférieur |

StratInfer gagne nettement sur le chemin froid mais perd 50,9 ms sur la reprise déjà
mise en cache. Cette régression doit rester visible : elle ne remet pas en cause le gain
global, mais constitue la priorité d'optimisation suivante.

## TTFT et énergie

| Mesure, médiane de cinq | Strata | StratInfer | Écart |
|---|---:|---:|---:|
| TTFT | 467,2 ms | 428,9 ms | **-8,20 %** |
| TTFT p95 | 628,8 ms | 498,4 ms | **-20,74 %** |
| Décodage | 135,5 tok/s | 153,7 tok/s | **+13,43 %** |
| Temps total | 4 211,3 ms | 3 746,3 ms | **-11,04 %** |
| Énergie carte | 1 025,63 J | 974,44 J | **-4,99 %** |
| Énergie incrémentale | 675,07 J | 636,27 J | **-5,75 %** |
| Tokens par joule | 0,4992 | 0,5254 | **+5,25 %** |
| Puissance moyenne | 249,95 W | 249,93 W | -0,01 % |
| Pic de puissance | 322,26 W | 339,14 W | **+5,24 %** |
| Pic mémoire RTX 5090 | 29 749 MiB | 29 909 MiB | +0,54 % |

Le gain énergétique vient du temps d'exécution réduit, pas d'une baisse de puissance
moyenne. StratInfer monte ponctuellement plus haut en puissance. Le TTFT désigne ici le
premier token généré, y compris le raisonnement interne. Le modèle a consommé le budget
de cette charge en raisonnement ; aucune latence « premier contenu final visible » n'est
donc revendiquée.

## Mémoire longue, RTX 4080 et SSD

Après la campagne finale, StratInfer est sain et conserve sept conversations dans un
cache de **4 632 395 620 octets** sur un budget de 8 Gio. Pendant la batterie complète,
un snapshot antérieur a observé :

- 20 parkings, 8 restaurations et 4 évictions ;
- restauration de 70 479 tokens en 101,5 ms ;
- remise en cache de 70 564 tokens en 21,7 ms avec 872 774 784 octets KV réutilisés ;
- jusqu'à 7,90 Go de snapshots conversationnels.

Le profil réserve **au maximum 4 Gio** sur la RTX 4080, à la demande. La mémoire totale
de la carte est restée à **4 655 MiB utilisés** après la charge retenue : cette campagne
ne prouve donc pas que les 4 Gio ont été effectivement alloués par le serveur. Elle valide
séparément le chemin de copie sur 512 Mio, cinq allers-retours :

| Sens | Débit | Validation |
|---|---:|---|
| RTX 5090 vers RTX 4080 | 10,852 Gio/s | exacte |
| RTX 4080 vers RTX 5090 | 11,514 Gio/s | exacte |

CUDA ne signale pas d'accès peer natif entre ces cartes dans ce test ; le chemin de
secours reste néanmoins correct. Les données sont dans
[`peer-cache-live.json`](data/strata-vs-stratinfer-2026-11-01/stratinfer/peer-cache-live.json).

La mémoire contextuelle matricielle a été éprouvée sur 10 000 entrées, 512 dimensions et
500 recherches : **3 100 écritures/s**, **72,40 ms par recherche**, rappel top-5 de
**100 %**, 22,50 Mo utilisés. Le plafond SSD de 32 Gio est configuré mais n'a pas été
rempli par ce test ; aucune affirmation de performance à 32 Gio pleins n'est faite.

## Déterminisme

Les deux moteurs produisent **12 hashes différents de la première sortie sur 13
observations** malgré la même graine. L'échec se reproduit en série et avec intercalage.
StratInfer n'aggrave pas le résultat, mais ne le corrige pas. Les agents de codage qui
exigent une reproduction bit à bit doivent conserver les artefacts, tests et décisions
dans la mémoire durable plutôt que dépendre d'une régénération identique.

## MOAI et voix

- bascule vers Strata stable : 27,63 s ;
- bascule vers StratInfer : 40,04 s ;
- quatre PID Qwen3-ASR/Qwen3-TTS identiques avant et après les bascules ;
- RTX 4080 restée disponible pour les services voix ;
- état final : `stratinfer`, `switching=false`, santé `ok`, contexte 524 288.

La campagne mesure la préservation des processus voix, pas la qualité ASR/TTS ni leur
latence audio.

## Décision

| Porte | Résultat | Décision |
|---|---|---|
| qualité et instructions | 20/20 contre 20/20 | passée |
| contexte long jusqu'à 70,5K | 8/8 contre 8/8 | passée |
| décodage fixe | +9,19 %, IC positif | passée |
| préremplissage frais | +9,64 %, faible variance | passée |
| concurrence 1/2/4/8 | +16,77 % à +20,45 % | passée |
| TTFT / énergie | -8,20 % / -4,99 % | passée |
| reprise exacte | exacte, mais +6,42 % de latence | passée avec réserve |
| fiabilité API | 318/318 requêtes | passée |
| déterminisme live | 12/13 divergences dans les deux | échouée |
| allocation live des 4 Gio RTX 4080 | non observée | ouverte |
| SSD rempli jusqu'à 32 Gio | non exécuté | ouvert |
| endurance 24 h | non exécutée | ouverte |

**Recommandation : conserver StratInfer comme moteur actif dans MOAI**, avec Strata stable
comme rollback. Les trois travaux prioritaires sont : corriger la reprise chaude, rendre
le sampling live déterministe, puis exécuter une endurance de 24 heures qui force le cache
RTX 4080 et remplit progressivement la mémoire SSD.

## Limites

- Cinq répétitions donnent un bon signal local mais pas une généralisation à d'autres
  machines, modèles ou versions de pilote.
- Le comparatif oppose deux versions de moteur déployées ; il ne mesure pas uniquement
  l'effet des kernels `sm_120`.
- Les puissances viennent de `nvidia-smi` sous WDDM et représentent la carte entière.
- Le banc qualité est déterministe et ciblé, pas un benchmark académique exhaustif.
- Les labels historiques `code-8k`, `prose-2k` et `agent-32k` sont des noms de charge ;
  seuls les nombres de tokens publiés par le serveur font foi.
- Les calibrations écartées ne figurent pas dans les données retenues.

## Données et reproduction

- [résumé calculé](data/strata-vs-stratinfer-2026-11-01/summary.json)
- [environnement](data/strata-vs-stratinfer-2026-11-01/environment.json)
- [état runtime final](data/strata-vs-stratinfer-2026-11-01/runtime-state.json)
- [données Strata](data/strata-vs-stratinfer-2026-11-01/strata/)
- [données StratInfer](data/strata-vs-stratinfer-2026-11-01/stratinfer/)

Commandes principales :

```powershell
$env:STRATINFER_BASE = "http://127.0.0.1:11440" # puis 11441
node scripts/bench_ab.mjs --label engine --repeat 5 --out reports/data/campaign/engine
node scripts/bench_fresh.mjs --label engine --tokens 32000 --trials 5 --out reports/data/campaign/engine
node scripts/bench_concurrency.mjs --levels 1,2,4,8 --trials 5 --tokens 256 --out reports/data/campaign/engine
node scripts/bench_replay.mjs --tokens 64000 --out reports/data/campaign/engine
node scripts/bench_quality.mjs --label engine --trials 2 --tokens 512 --nonce campaign-v2 --out reports/data/campaign/engine
node scripts/bench_efficiency.mjs --label engine --trials 5 --tokens 512 --out reports/data/campaign/engine
node scripts/verify_determinism.mjs --serial 5 --rounds 8 --concurrency 4 --tokens 128 --out reports/data/campaign/engine
node scripts/summarize_comparison.mjs --root reports/data/campaign
```
