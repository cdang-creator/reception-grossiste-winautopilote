# Contrôle réception — BL CERP ↔ Réception Winpharma

Application web pour réconcilier les bons de livraison CERP avec l'état de réception
Winpharma. Elle compare le montant total, et en cas d'écart trouve les lignes
(quantités et prix) qui l'expliquent. Lecture des scans assurée par l'IA, côté serveur.

Une fois déployée, c'est une URL ouvrable sur n'importe quel poste de la pharmacie.

---

## Ce qu'il vous faut

1. **Une clé API Anthropic** — créez-la sur https://console.anthropic.com (section API Keys).
   C'est elle qui paie la lecture des documents (à vos frais, facturation à l'usage, faible).
2. **Un compte Vercel** (gratuit) — https://vercel.com
3. **Node.js installé** sur votre poste (https://nodejs.org) si vous passez par la ligne de commande.

---

## Déploiement — méthode la plus simple (ligne de commande)

```bash
# 1. Dans le dossier du projet :
npm install
npm install -g vercel

# 2. Lancer le déploiement (suivez les questions, répondez par défaut) :
vercel

# 3. Ajouter votre clé API, puis redéployer en production :
vercel env add ANTHROPIC_API_KEY        # collez votre clé quand c'est demandé
vercel --prod
```

Vercel vous renvoie une URL du type `https://votre-projet.vercel.app` — c'est le lien à
diffuser dans la pharmacie.

## Déploiement — via GitHub (interface web)

1. Mettez ce dossier sur un dépôt GitHub.
2. Sur Vercel : **Add New → Project → Import** votre dépôt.
3. Dans **Settings → Environment Variables**, ajoutez `ANTHROPIC_API_KEY` (votre clé).
4. **Deploy**. L'URL est générée.

---

## Variables d'environnement

| Variable | Obligatoire | Rôle |
|---|---|---|
| `ANTHROPIC_API_KEY` | Oui | Votre clé API Anthropic (lecture des documents). |
| `SITE_PASSWORD` | Non | Si renseignée, l'outil demande ce mot de passe avant toute analyse. **Recommandé** : l'URL est publique, ça évite qu'un inconnu consomme votre crédit API. |
| `ANTHROPIC_MODEL` | Non | Modèle de lecture (défaut `claude-sonnet-4-6`). |

Après avoir ajouté ou modifié une variable, relancez un déploiement (`vercel --prod`
ou bouton *Redeploy* sur Vercel) pour qu'elle soit prise en compte.

---

## Protéger l'accès (important)

L'URL est publique. Deux options pour la réserver à la pharmacie :

- **Simple** : définissez `SITE_PASSWORD` (un mot de passe partagé à l'équipe).
- **Plateforme** : sur Vercel, *Settings → Deployment Protection* (protection par mot de
  passe au niveau du site — selon votre offre Vercel).

---

## Bon à savoir

- **Coût** : chaque comparaison = quelques lectures facturées sur votre clé API. Négligeable
  pour quelques réceptions/jour, mais c'est métré — surveillez votre console Anthropic.
- **Taille des fichiers** : les photos sont automatiquement réduites. Un PDF doit rester
  sous ~4 Mo (sinon scannez-le en noir et blanc, résolution plus basse, ou en deux fichiers).
- **Fiabilité** : c'est un contrôle de **première passe**. L'outil affiche un avertissement
  si le total imprimé ne colle pas aux lignes lues. Vérifiez toujours le détail (« Voir le
  détail des lignes lues ») avant de réclamer un avoir à CERP.
- **Développement local** : créez un fichier `.env.local` avec `ANTHROPIC_API_KEY=...`,
  puis `npm run dev` (ouvre http://localhost:3000).
