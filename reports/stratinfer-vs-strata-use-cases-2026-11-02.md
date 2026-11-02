# Strata contre StratInfer — cas d'usage chiffrés

Date : 2 novembre 2026

Machine : RTX 5090 + RTX 4080 SUPER, i9-14900K, 127,7 Gio de RAM

Modèle : même Qwen3.8-Flash-Next IQ3_S et mêmes fichiers GGUF pour les deux moteurs

Statut : synthèse des campagnes live terminées, projections reproductibles ajoutées

## Verdict exécutif

**StratInfer reste le meilleur moteur général sur cette machine**, avec la même réussite
fonctionnelle observée que Strata et des gains nets sur le décodage, le préremplissage,
le contexte long, l'énergie et la concurrence. Le bénéfice le plus concret apparaît pour
les agents de codage parallèles : à concurrence 2, le débit mesuré gagne **20,45 %** et
une production projetée de 100 000 tokens économise **2 min 19 s**.

Strata conserve trois avantages ponctuels : une reprise chaude de 101 453 tokens plus
rapide de **50,9 ms**, 160 Mio de VRAM principale en moins au pic mesuré, et une pile
plus simple lorsqu'aucune mémoire durable ni orchestration n'est nécessaire.

| Usage | Résultat StratInfer | Décision |
|---|---:|---|
| Réponse de 512 tokens | 3,746 s contre 4,211 s | StratInfer, **465 ms gagnées** |
| Codage, 100 000 tokens de sortie | 12 min 31 s contre 14 min 09 s | StratInfer, **1 min 38 s gagnée** |
| Prompt frais de 61 000 tokens | 12,049 s contre 13,210 s | StratInfer, **1,161 s gagnée** |
| Deux agents, 100 000 tokens agrégés | 11 min 18 s contre 13 min 37 s | StratInfer, **2 min 19 s gagnées** |
| Reprise chaude de 101 453 tokens | 843,7 ms contre 792,8 ms | Strata, **50,9 ms gagnées** |
| 100 tours, dont 20 avec outil | MCP sélectif : 54,16 s contre 136,68 s toujours actif | Sélectif, **82,52 s gagnées** |
| Qualité de la batterie | 20/20 contre 20/20 | égalité observée |

## Lecture des chiffres

Deux catégories sont volontairement séparées :

- **mesure** : valeur observée directement pendant les campagnes live publiées ;
- **projection** : multiplication ou division linéaire d'une moyenne ou médiane mesurée,
  utile pour rendre l'écart concret mais ne remplaçant pas un essai d'endurance complet.

Les projections de ce rapport sont générées par
[`scripts/project_use_cases.mjs`](../scripts/project_use_cases.mjs) à partir des JSON
bruts, sans ressaisie manuelle. Leur sortie est
[`scenario-projections.json`](data/stratinfer-vs-strata-use-cases-2026-11-02/scenario-projections.json).

La comparaison porte sur les **deux moteurs déployés complets**, pas sur une seule
fonction isolée. Ils utilisent le même modèle et le même matériel, mais StratInfer ajoute
notamment ses optimisations `sm_120`, les sessions durables, la mémoire auxiliaire et
l'intégration FastMCP.

## 1. Réponses interactives et énergie

La campagne énergétique a généré cinq fois 512 tokens par moteur.

| Mesure directe | Strata | StratInfer | Écart StratInfer |
|---|---:|---:|---:|
| TTFT médian | 467,2 ms | 428,9 ms | **-8,20 %** |
| TTFT p95 | 628,8 ms | 498,4 ms | **-20,74 %** |
| Décodage médian | 135,5 tok/s | 153,7 tok/s | **+13,43 %** |
| Temps total médian | 4,211 s | 3,746 s | **-11,04 %** |
| Énergie médiane | 1 025,63 J | 974,44 J | **-4,99 %** |
| Efficacité | 0,4992 tok/J | 0,5254 tok/J | **+5,25 %** |
| Puissance de pointe | 322,26 W | 339,14 W | **+5,24 %** |
| VRAM RTX 5090 de pointe | 29 749 Mio | 29 909 Mio | **+160 Mio** |

StratInfer termine donc plus vite et consomme moins d'énergie totale, mais demande un
pic de puissance et de VRAM légèrement supérieur.

| Volume projeté à partir de la médiane | Strata | StratInfer | Temps gagné | Énergie gagnée |
|---|---:|---:|---:|---:|
| 1 réponse, 512 tokens | 4,211 s | 3,746 s | 0,465 s | 51,19 J |
| 100 réponses, 51 200 tokens | 7 min 01 s | 6 min 15 s | 46,5 s | 1,422 Wh |
| 1 000 réponses, 512 000 tokens | 1 h 10 min 11 s | 1 h 02 min 26 s | 7 min 45 s | 14,219 Wh |

Exemple concret : un agent qui produit 100 réponses de 512 tokens pendant une séance
économise environ **46,5 secondes** de calcul et **5 119 J**. Cette projection suppose
des requêtes comparables et n'intègre pas le temps humain, les outils ou le réseau.

## 2. Codage, prose et agents à contexte long

Les débits ci-dessous sont mesurés sur cinq répétitions par charge. Le temps pour
100 000 tokens est ensuite projeté à débit constant.

| Charge | Débit Strata | Débit StratInfer | Gain mesuré | IC 95 % | Temps Strata | Temps StratInfer | Gain projeté |
|---|---:|---:|---:|---:|---:|---:|---:|
| Code, contexte 8K | 117,72 tok/s | 133,10 tok/s | **+13,07 %** | +6,83 à +18,92 % | 14 min 09 s | 12 min 31 s | **1 min 38 s** |
| Prose, contexte 2K | 108,18 tok/s | 117,02 tok/s | **+8,17 %** | +0,40 à +16,37 % | 15 min 24 s | 14 min 15 s | **1 min 10 s** |
| Agent, contexte 32K | 93,78 tok/s | 98,94 tok/s | **+5,50 %** | -0,95 à +12,04 % | 17 min 46 s | 16 min 51 s | **55,6 s** |

Le gain « agent 32K » est prometteur mais **pas statistiquement établi seul**, car son
intervalle de confiance traverse zéro. Le gain global des quinze paires de décodage est
de **+9,19 %**, avec un IC 95 % de **+5,60 à +12,26 %**.

Cas pratique : pour un chantier qui produit 500 000 tokens de code dans des conditions
semblables à `code-8k`, l'extrapolation est de **8 min 11 s gagnées**. Une vraie séance
sera moins linéaire à cause des préremplissages, appels d'outils, reprises et périodes
d'inactivité.

## 3. Gros prompts et contexte long

Le préremplissage frais d'environ 61 000 tokens atteint **4 617,8 tok/s** avec Strata et
**5 062,8 tok/s** avec StratInfer, soit **+9,64 %** avec un IC 95 % de
**+8,71 à +10,56 %**. À volume constant, cela représente 13,210 s contre 12,049 s,
donc **1,161 s gagnée** par prompt frais.

Les tests d'aiguille ont réussi 8/8 contrôles sur chaque moteur :

| Taille réelle du prompt | Strata mesuré | StratInfer mesuré | Écart de latence |
|---|---:|---:|---:|
| 2 309 tokens | 1 989,95 ms | 1 883,95 ms | **-5,33 %** |
| 8 909 tokens | 3 116,60 ms | 2 913,60 ms | **-6,51 %** |
| 35 310 tokens | 8 679,65 ms | 7 901,35 ms | **-8,97 %** |
| 70 510 tokens | 15 435,20 ms | 14 082,60 ms | **-8,76 %** |

StratInfer ne dégrade donc pas la récupération de l'information dans cette batterie et
réduit la latence mesurée à chaque profondeur. Deux répétitions seulement ont toutefois
été exécutées par profondeur : ce résultat valide le fonctionnement, pas une borne de
performance universelle.

## 4. Agents spécialisés en parallèle

Le débit concurrent est un avantage plus marqué que le débit séquentiel. Les temps de
100 000 tokens agrégés sont des projections basées sur les médianes mesurées.

| Agents simultanés | Débit Strata | Débit StratInfer | Gain de débit | Temps Strata | Temps StratInfer | Temps gagné | p95 gagnée |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 122,36 tok/s | 143,23 tok/s | **+17,06 %** | 13 min 37 s | 11 min 38 s | 1 min 59 s | 378 ms |
| 2 | 122,43 tok/s | 147,47 tok/s | **+20,45 %** | 13 min 37 s | 11 min 18 s | 2 min 19 s | 758,8 ms |
| 4 | 123,98 tok/s | 145,42 tok/s | **+17,29 %** | 13 min 27 s | 11 min 28 s | 1 min 59 s | 1 373,6 ms |
| 8 | 124,61 tok/s | 145,51 tok/s | **+16,77 %** | 13 min 23 s | 11 min 27 s | 1 min 55 s | 2 502,1 ms |

**Concurrence 2 est le meilleur point de fonctionnement mesuré** : débit maximal et
gain relatif maximal, sans la forte latence p95 des niveaux 4 et 8. Pour une architecture
de développement, cela favorise deux agents actifs — par exemple implémentation et test —
et des spécialistes supplémentaires en attente ou déclenchés à la demande.

## 5. Reprise, RTX 4080 et mémoire longue durée

Sur un prompt exact de 101 453 tokens :

| Chemin | Strata | StratInfer | Verdict |
|---|---:|---:|---|
| Chargement froid | 21 553,4 ms | 19 522,8 ms | StratInfer gagne **2 030,6 ms** |
| Reprise chaude | 792,8 ms | 843,7 ms | Strata gagne **50,9 ms** |
| Réutilisation exacte | 99,9724 % | 99,9724 % | égalité |

Sur 100 chargements froids comparables, la projection favorise StratInfer de
**3 min 23 s**. Sur 100 reprises déjà chaudes, elle favorise Strata de **5,09 s**. Le
choix dépend donc du profil : StratInfer pour charger ou reconstruire de gros contextes,
Strata pour une boucle composée exclusivement de reprises déjà résidentes.

La mémoire de soutien StratInfer a aussi été validée séparément :

- matrice de 10 000 entrées × 512 dimensions : **3 100 écritures/s**, requête moyenne
  **72,40 ms**, rappel top-5 synthétique **100 %**, empreinte **22,50 Mo** ;
- transfert validé RTX 5090 vers RTX 4080 SUPER : **10,852 Gio/s** ;
- transfert inverse : **11,514 Gio/s** ;
- absence de peer access natif, donc passage par mémoire hôte épinglée ;
- restauration live observée de 70 479 tokens en **101,5 ms** et recache de 70 564
  tokens en **21,7 ms** dans la campagne longue session ;
- projection d'une copie brute de 3,44 Gio : **317,0 ms** vers la RTX 4080 et
  **298,8 ms** au retour, hors sérialisation et orchestration.

Les **4 Gio de RTX 4080** constituent un plafond à la demande et non une réservation
permanente. Les **32 Gio SSD** bornent la mémoire durable. Le remplissage réel complet
des deux plafonds et l'endurance continue de 24 heures restent des gates ouvertes ; il
ne faut pas présenter la projection de copie comme un temps de restauration de session.

## 6. FastMCP : actif, mais seulement à la demande

FastMCP expose six outils de codage. Le serveur stdio reste actif, tandis que leurs
schémas ne sont ajoutés au prompt que lorsque la requête positionne `strata_mcp: true`.

Mesures directes sur dix essais par chemin :

| Chemin | Latence médiane | Tokens de prompt médians | Coût outil seul |
|---|---:|---:|---:|
| Sans MCP | 172,8 ms | 35 | — |
| Schémas MCP annoncés, aucun appel | 1 204,3 ms | 827 | — |
| Un appel réel | 2 016,8 ms | 1 154 | 30 ms |

L'outil `git_status` seul prend **28,8 ms** en médiane et **30,4 ms** en p95. Le coût
principal vient donc du préremplissage des schémas et du second tour du modèle, pas du
transport FastMCP.

Projection pour 100 tours, en comparant MCP sélectif à MCP annoncé sur tous les tours :

| Tours avec outil | Temps sélectif | Temps toujours actif | Temps gagné | Tokens de prompt évités |
|---:|---:|---:|---:|---:|
| 0/100 | 17,280 s | 120,430 s | **103,150 s** | **79 200** |
| 5/100 | 26,500 s | 124,493 s | **97,993 s** | **75 240** |
| 20/100 | 54,160 s | 136,680 s | **82,520 s** | **63 360** |
| 50/100 | 109,480 s | 161,055 s | **51,575 s** | **39 600** |
| 100/100 | 201,680 s | 201,680 s | 0 s | 0 |

Exemple concret : dans une séance de 100 tours où un agent appelle un outil une fois sur
cinq, l'activation sélective économise environ **1 min 23 s** et **63 360 tokens de
prompt** face à l'annonce permanente des outils.

FastMCP n'est pas un avantage intrinsèque exclusif du moteur : Strata sait également
servir MCP. L'avantage actuel de StratInfer est son intégration active, confinée au dépôt,
sa mémoire FTS5 persistante et sa politique opt-in déjà validée. À outils et schémas
identiques, Strata subirait probablement un surcoût MCP du même ordre ; ce point n'a pas
fait l'objet d'un A/B moteur dédié.

## 7. Déterminisme et qualité

La batterie de qualité donne **20/20 pour les deux moteurs**, dont 8/8 en contexte long.
Elle ne prouve pas une qualité générale identique sur tous les corpus, mais aucune
régression n'a été détectée dans les cas couverts.

Le profil de performance n'est pas byte-identique : Strata et StratInfer ont chacun
divergé 12 fois sur 13 dans le test live intercalé. Le profil strict à placement fixe a
réussi 13/13, mais ne décode que **2,1 à 2,7 tok/s**, contre **143,7 tok/s** de médiane
retenue pour le profil de performance. Il est donc environ **53 à 68 fois plus lent**.

Conséquence pratique :

- conserver le profil performant pour chat, vision, codage, agents et MCP ;
- activer le profil strict uniquement pour un test qui exige une sortie échantillonnée
  byte-identique ;
- ne pas attendre de ce profil qu'il rende déterministes l'état Git, le contenu des
  fichiers ou les résultats d'outils externes.

## 8. Choix recommandé par situation

| Situation | Choix | Motif principal |
|---|---|---|
| Codage interactif | **StratInfer** | TTFT -8,20 %, décodage +13,43 % sur la charge énergie |
| Génération massive de code | **StratInfer** | 1 min 38 s projetée par 100 000 tokens `code-8k` |
| Deux agents spécialisés actifs | **StratInfer** | meilleur débit mesuré, +20,45 % |
| Prompt frais de 61K à 70K | **StratInfer** | préremplissage +9,64 %, contexte long plus rapide |
| Mémoire durable et reprise après éviction | **StratInfer** | cache RTX 4080, SSD, matrice et checkpoints |
| Uniquement des reprises chaudes résidentes | **Strata** | 50,9 ms de moins par reprise mesurée |
| VRAM principale à 160 Mio près | **Strata** | pic mesuré légèrement inférieur |
| Outils de codage occasionnels | **StratInfer + MCP sélectif** | aucun schéma sur les tours ordinaires |
| Reproduction byte-identique | **profil strict séparé** | déterministe, mais 53 à 68 fois plus lent |

## Limites et prochaines validations

- Les temps à 100 000 ou 500 000 tokens sont des extrapolations linéaires, pas des runs
  continus de cette taille.
- L'énergie repose sur cinq générations de 512 tokens ; une endurance longue peut changer
  les températures, fréquences et moyennes.
- L'IC 95 % de la charge `agent-32k` traverse zéro ; davantage de répétitions sont requises.
- La qualité 20/20 est une batterie de non-régression, pas un benchmark académique large.
- Le test FastMCP compare les politiques de schémas sur StratInfer, pas deux serveurs MCP
  identiques exécutés sur chaque moteur.
- Le remplissage de 4 Gio sur la RTX 4080, de 32 Gio sur SSD et l'endurance de 24 heures
  restent à exécuter avant de revendiquer ces plafonds sous charge soutenue.
- L'API reste locale sur `127.0.0.1` sans clé ; elle ne doit pas être exposée directement.

## Reproduction et preuves

```powershell
node --check scripts/project_use_cases.mjs
node scripts/project_use_cases.mjs
```

Sources principales :

- [`strata-vs-stratinfer-2026-11-01.md`](strata-vs-stratinfer-2026-11-01.md) ;
- [`fastmcp-2026-11-02.md`](fastmcp-2026-11-02.md) ;
- [`long-session-memory-2026-11-01.md`](long-session-memory-2026-11-01.md) ;
- [`summary.json`](data/strata-vs-stratinfer-2026-11-01/summary.json) ;
- [`scenario-projections.json`](data/stratinfer-vs-strata-use-cases-2026-11-02/scenario-projections.json).
