# GUIDE UTILISATEUR — Bot d’Auto‑Booking Blacklane (Chauffeurs VIP) 🚘✨

Bienvenue. Ce bot a été conçu comme un **dispatcher personnel** : il surveille les nouvelles courses **24h/24, 7j/7** en arrière‑plan, et réserve automatiquement celles qui correspondent à **vos critères**. 🤝

> **Important : le bot ne “devine” pas — il applique vos règles avec précision, de manière fiable et constante.**

---

## 1) Introduction & La Règle d’Or 🏆

### Comment ça fonctionne (très simplement) 🧠
- Le bot **scanne** régulièrement les nouvelles opportunités.
- Il **compare** chaque course à vos réglages.
- Si la course correspond, il **réserve** automatiquement.

### La Règle d’Or (à retenir) 🏆
**Le bot fonctionne avec une logique stricte d’accumulation : pour qu’une course soit acceptée, elle doit valider _TOUS_ les filtres activés en même temps.**  
**Même si 9 filtres sont OK, si 1 seul bloque → la course est ignorée.**

---

## 2) Le Catalogue des Filtres ⚙️

Chaque section ci‑dessous correspond à un filtre **réellement appliqué** par le bot. Activez seulement ce dont vous avez besoin, surtout au démarrage. ✅

---

### Filtre “Prix Minimum” 💶⬆️
**À quoi ça sert ?**  
Empêche le bot de réserver des courses jugées “pas assez rentables” en dessous de votre seuil.

> 💡 **Exemple pratique**  
Vous fixez un **minimum à 80€**. Une course à **75€** est ignorée. Une course à **95€** passe ce filtre.

---

### Filtre “Prix Maximum” 💶⬇️ 
**À quoi ça sert ?**  
Évite les courses au‑dessus d’un certain prix (ex: vous ne souhaitez pas certains trajets très longs, ou vous préférez une zone précise).

> 💡 **Exemple pratique**  
Vous fixez un **maximum à 250€**. Une course à **320€** est ignorée. Une course à **210€** passe.

---

### Filtre “Type de Véhicule / Gamme” 🚙⭐
**À quoi ça sert ?**  
Réserve uniquement les courses compatibles avec les catégories de véhicule que vous acceptez (ex: Business, First, Van… selon votre configuration).

> 💡 **Exemple pratique**  
Vous n’acceptez que **Business**. Une course en **Van** est ignorée, même si le prix est bon.

---

### Filtre “Type de Course (Transfer / Hourly)” ⏱️🛣️
**À quoi ça sert ?**  
Vous permet de choisir entre :
- **Transfer** : trajet A → B
- **Hourly** : mise à disposition à l’heure
- **Both** : les deux (plus large)

> 💡 **Exemple pratique**  
Vous sélectionnez **Transfer uniquement** : une mise à disposition **Hourly** est ignorée.

---

### Filtre “Délai Minimum avant Départ” ⏳🗓️
**À quoi ça sert ?**  
Évite les courses “trop proches” dans le temps, pour vous laisser une marge (préparation, repositionnement, confort).

> 💡 **Exemple pratique**  
Vous mettez **minimum 6h**. Une course qui démarre dans **2h** est ignorée ; une course dans **8h** passe.

---

### Filtre “Horaires de Travail” 🕒🧑‍✈️
**À quoi ça sert ?**  
Le bot réserve uniquement les courses dont **l’heure de départ** tombe dans votre plage horaire (ex: 06:00 → 22:00).

> 💡 **Exemple pratique**  
Vous travaillez **06:00–22:00**. Une course à **23:15** est ignorée, même si elle est très bien payée.

---

### Filtre “Conflit d’Agenda / Marge entre Courses” 🧩📆
**À quoi ça sert ?**  
Empêche le bot de réserver une course qui **chevauche** une course déjà planifiée, ou qui est **trop proche** avant/après (marge de sécurité).

> 💡 **Exemple pratique**  
Vous fixez **30 min de marge**.  
- Course existante fin à **14:00** → une nouvelle course à **14:10** est ignorée.  
- Une nouvelle course à **14:45** passe.

---

### Filtre “Aéroport (Pickup / Dropoff)” ✈️📍
**À quoi ça sert ?**  
Contrôle si vous acceptez les courses **liées à un aéroport** :
- aéroport au **départ** (Pickup)
- aéroport à l’**arrivée** (Dropoff)
- ou **les deux**

> 💡 **Exemple pratique**  
Vous autorisez seulement **Dropoff aéroport** :  
- Centre‑ville → Aéroport ✅  
- Aéroport → Centre‑ville ❌

> 📝 **Note spéciale (très important)**  
Si la course **ne concerne pas un aéroport** (ex: centre‑ville → centre‑ville), le bot **ignore intelligemment ce filtre** et laisse passer la course (si le reste est OK). 🧠✅

---

### Filtre “Compagnies Aériennes (si vol renseigné)” 🛫🏷️
**À quoi ça sert ?**  
Si une course contient un numéro de vol, vous pouvez limiter les réservations à **certaines compagnies** (ex: AF, DL, EK…).

> 💡 **Exemple pratique**  
Vous autorisez **AF** et **DL** :  
- Vol **AF1234** ✅  
- Vol **LH999** ❌

> 📝 **Note spéciale (très important)**  
Si la course **n’a pas de numéro de vol**, le bot **n’applique pas ce filtre** (il ne vous bloque pas “à cause d’un vol absent”). ✅

---

### Filtre “Villes Autorisées au Départ (Pickup)” 🏙️🟢
**À quoi ça sert ?**  
Réserve uniquement les courses dont la **ville de départ** fait partie de votre liste autorisée.

> 💡 **Exemple pratique**  
Vous autorisez **Paris** et **Neuilly‑sur‑Seine** :  
- Départ **Paris** ✅  
- Départ **Versailles** ❌

---

### Filtre “Villes Autorisées à l’Arrivée (Dropoff)” 🏙️🎯
**À quoi ça sert ?**  
Réserve uniquement les courses dont la **ville d’arrivée** fait partie de votre liste autorisée.

> 💡 **Exemple pratique**  
Vous autorisez **Paris** :  
- Arrivée **Paris** ✅  
- Arrivée **Roissy** ❌ (si Roissy n’est pas dans votre liste)

---

### Filtre “Dates Blacklist (Jours à Refuser)” 🚫📅
**À quoi ça sert ?**  
Permet d’interdire certains jours (congés, indisponibilités, événements personnels). Le bot ignore toute course dont la date tombe sur un de ces jours.

> 💡 **Exemple pratique**  
Vous bloquez le **2026‑04‑15** : toute course ce jour‑là est ignorée, même si le prix est excellent.

---

### Filtre “Fenêtre de Dates Autorisées (Du / Au)” 🗓️✅
**À quoi ça sert ?**  
Autorise les courses uniquement dans une **période précise** :
- **Date de début** (à partir de…)
- **Date de fin** (jusqu’à…)

> 💡 **Exemple pratique**  
Vous autorisez du **1er juin** au **30 juin** :  
- Course le **15 juin** ✅  
- Course le **2 juillet** ❌

---

## 3) Conclusion / Astuces de rentabilité 🚀

Pour démarrer sereinement (et ne pas “rater” de belles courses), l’approche la plus rentable est souvent progressive. 🎯

- **Commencez large**, puis resserrez : mettez un **prix minimum raisonnable**, et évitez d’activer trop de filtres d’un coup.
- **Évitez les listes trop courtes** (villes, véhicules, compagnies) au début : c’est efficace, mais ça peut vite devenir ultra‑restrictif.
- **Ajoutez une marge d’agenda réaliste** : trop grande = moins de courses ; trop petite = stress logistique.
- **Testez 24–48h**, puis ajustez : le bot est constant, c’est donc vos réglages qui font la différence. ✅

> Besoin d’un réglage “VIP” simple et efficace ?  
> Gardez 2–3 filtres clés au départ (prix min + horaires + marge agenda), puis ajustez selon votre zone et votre rythme. 🧠✨

