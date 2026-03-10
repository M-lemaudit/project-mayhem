# Déploiement en production

Guide pour déployer le bot Blacklane et l’admin sur un serveur de production.

## 1. Prérequis

- Node.js (version supportée par le projet)
- Accès au projet Supabase (prod ou dédié)
- Comptes Blacklane et proxy configurés si besoin

## 2. Base de données Supabase

- Appliquer **toutes** les migrations dans l’ordre sur la base de production :
  - `supabase/migrations/20260216000000_create_bots_table.sql`
  - `supabase/migrations/20260216100000_add_paused_rate_limit_status.sql`
  - `supabase/migrations/20260216110000_enable_realtime_on_bots.sql`
  - `supabase/migrations/20260216200000_create_global_settings.sql`
  - `supabase/migrations/20260217100000_add_proxy_to_bots.sql`
  - `supabase/migrations/20260217110000_add_sleeping_status.sql`
  - `supabase/migrations/20260217120000_add_stealth_geo_to_bots.sql`
  - `supabase/migrations/20260218100000_create_rides_table.sql`
  - `supabase/migrations/20260218110000_add_pickup_dropoff_to_rides.sql`
- Ou utiliser la CLI Supabase : `supabase db push` (après liaison au projet).

## 3. Variables d’environnement (bot)

Sur le serveur, créer un fichier `.env` (ou configurer les variables dans l’hébergeur) à partir de `.env.example`. **Ne pas réutiliser le `.env` de dev** ; utiliser des secrets dédiés à la production.

Variables **obligatoires** en prod :

| Variable | Description | Exemple prod |
|----------|-------------|--------------|
| `SUPABASE_URL` | URL du projet Supabase | `https://xxx.supabase.co` |
| `SUPABASE_KEY` | Clé anon Supabase | (clé anon du projet) |
| `SUPABASE_SERVICE_ROLE_KEY` | Clé service role (bypass RLS) | (clé service role) |
| `IS_PRODUCTION` | Activer les vrais appels Blacklane | `true` |
| `NODE_ENV` | Environnement Node | `production` |
| `BLACKLANE_API_URL` | URL API Blacklane | `https://athena.blacklane.com` |
| `ENCRYPTION_KEY` | Clé de chiffrement (32 bytes hex) | (même clé que l’admin si utilisé) |

Variables **optionnelles** :

- `BLACKLANE_EMAIL` / `BLACKLANE_PASSWORD` : pour tests manuels (éviter les comptes perso en prod).
- `LOG_LEVEL` : `info` ou `warn` en prod.
- `PROXY_URL` : proxy HTTP si nécessaire.

**Important** : En production, `IS_PRODUCTION=true` est requis pour que le bot envoie de vraies acceptations d’offres à Blacklane. Sinon, seul un mode simulation est utilisé.

## 4. Build et démarrage du bot

```bash
npm ci
npm run build
npm run start
```

Pour faire tourner en arrière-plan : utiliser un process manager (systemd, PM2, etc.) qui lance `node dist/index.js` (ou `npm run start`) avec le répertoire de travail contenant le `.env`.

## 5. Admin (Next.js)

Si l’admin est déployé :

- Dans le répertoire `admin/`, configurer les variables d’environnement (voir `admin/.env.example`).
- `NEXT_PUBLIC_SUPABASE_URL` et `NEXT_PUBLIC_SUPABASE_ANON_KEY` doivent pointer vers le même projet Supabase que le bot.
- `ENCRYPTION_KEY` doit être **identique** à celui du bot si l’admin gère le chiffrement des mots de passe.
- Dans Supabase : désactiver l’inscription publique (Auth > Providers > Email) et créer les comptes admin à la main.

## 6. Checklist avant mise en prod

- [ ] Migrations Supabase appliquées sur la base prod
- [ ] `.env` (ou variables d’env) configuré sur le serveur avec des secrets **prod**
- [ ] `IS_PRODUCTION=true` et `NODE_ENV=production` sur le serveur du bot
- [ ] `SUPABASE_SERVICE_ROLE_KEY` défini pour le bot
- [ ] Si admin déployé : même `ENCRYPTION_KEY` que le bot, signup désactivé
- [ ] Fichier `.env` jamais commité (déjà dans `.gitignore`)
