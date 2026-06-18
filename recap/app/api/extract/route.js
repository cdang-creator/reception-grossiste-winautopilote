export const runtime = "nodejs";
export const maxDuration = 60;
const PROMPT = `Tu lis un document de pharmacie : soit un BON DE LIVRAISON CERP (scan d'un bon papier), soit un état de réception/commande Winpharma (WinAutopilote).
Renvoie UNIQUEMENT du JSON valide et compact, sans aucun texte autour ni balises Markdown.
Schéma à clés courtes, à respecter exactement :
{"t":"BL"|"WP"|"X","T":nombre|null,"L":[{"c":"chiffres du code|null","d":"désignation","q":nombre,"p":nombre|null,"m":nombre|null}]}

QUEL TABLEAU LIRE (TRÈS IMPORTANT) :
Sur un BON DE LIVRAISON CERP scanné, il y a souvent DEUX zones côte à côte :
  - à GAUCHE un bon de préparation interne (codes courts type "Code géo", "Code Vérif", "Prix EUR") ;
  - à DROITE le BON OFFICIEL CERP : colonnes "Code article" (code CIP à 13 chiffres), "Dénomination", "Qté Livrée", "Prix unitaire HT", "Montant HT", avec un grand TOTAL en bas à droite.
→ Lis UNIQUEMENT le bon officiel de DROITE. IGNORE totalement le bon de préparation de gauche : il fait doublon et utilise des codes courts qui faussent tout.
Sur un document Winpharma/commande, lis simplement le tableau principal.

COMMANDÉ vs REÇU/LIVRÉ : prends TOUJOURS le réellement REÇU/LIVRÉ, jamais le commandé.
- Quantité : prends la quantité LIVRÉE/REÇUE (colonne "Qté Livrée" sur un BL, "QtéR" sur Winpharma). Jamais la commandée ("Qté Cdée"/"Qté").
- Montant : prends le "Montant HT" de la dernière colonne (= Qté Livrée × Prix unitaire HT net) sur un BL, ou "Mt HT Reçu" sur Winpharma. Jamais le montant commandé.
- IGNORE les lignes non livrées/non reçues (quantité = 0) : ne les mets pas dans L.

t = type du document ("BL" pour un bon de livraison, "WP" pour Winpharma/commande, "X" si incertain).
T = TOTAL HT réellement livré/reçu du document :
    - BL : le grand TOTAL en bas à droite du bon officiel. ATTENTION : ce document peut contenir PLUSIEURS bons (plusieurs pages, donc plusieurs "TOTAL"). Dans ce cas, ADDITIONNE tous ces totaux et mets la SOMME dans T (un seul nombre pour tout le document).
    - Winpharma : le total de la colonne "Mt HT Reçu". Exemple réel de ligne de totaux Winpharma :
      "Qté: 145 2593 365 2228 676 18670,18 19192,18 4204,70 4346,48" → T = 4204,70 (le HT Reçu), surtout PAS 18670,18 (le commandé).
    null si vraiment absent.
L = une entrée par ligne livrée/reçue. Pour chaque ligne :
  c = le code CIP/EAN COMPLET. Un code CIP fait 13 chiffres. Il est très souvent affiché en GROUPES séparés par des espaces, par exemple "34009 3027387 6" : tu DOIS recoller tous les groupes pour donner les 13 chiffres d'affilée, ici "3400930273876". Ne renvoie JAMAIS seulement le groupe du milieu ("3027387") ni un code partiel : toujours les 13 chiffres complets, sans espaces ni lettres. null seulement si le code est vraiment absent. N'utilise jamais un code court interne du bon de préparation.
  d = désignation, raccourcie à ~30 caractères maximum si elle est longue.
  q = quantité LIVRÉE/REÇUE.
  p = prix unitaire HT net de la ligne ; null si absent.
  m = montant HT de la ligne (Qté × PU HT net, la dernière colonne) ; null si absent.
Impératifs : extrais CHAQUE ligne livrée/reçue. N'invente aucune valeur (null si illisible). Nombres au
format français ("1 234,56") renvoyés en nombres JSON standard (1234.56). Aucune autre clé.`;
export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "requête invalide" }, { status: 400 });
  }
  const { data, mediaType, isPdf, password, hint } = body || {};
  // Protection optionnelle par mot de passe partagé
  if (process.env.SITE_PASSWORD && password !== process.env.SITE_PASSWORD) {
    return Response.json({ error: "mot de passe incorrect" }, { status: 401 });
  }
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return Response.json({ error: "clé API non configurée sur le serveur" }, { status: 500 });
  if (!data) return Response.json({ error: "aucun fichier reçu" }, { status: 400 });
  const block = isPdf
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data } }
    : { type: "image", source: { type: "base64", media_type: mediaType || "image/jpeg", data } };
  let r;
  try {
    r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
        max_tokens: 16000,
        messages: [
          {
            role: "user",
            content: [block, { type: "text", text: hint ? PROMPT + "\n\n" + hint : PROMPT }],
          },
        ],
      }),
    });
  } catch {
    return Response.json({ error: "service de lecture injoignable" }, { status: 502 });
  }
  const j = await r.json().catch(() => null);
  if (!r.ok || !j) {
    const detail = j && j.error && j.error.message ? j.error.message : "erreur du service de lecture";
    // Limite de débit Anthropic : on renvoie un VRAI 429 (+ retry-after) pour que
    // le client patiente et réessaie, au lieu de le masquer en 502 (= fausse panne).
    if (r.status === 429) {
      const ra = r.headers.get("retry-after");
      return Response.json(
        { error: detail },
        { status: 429, headers: ra ? { "retry-after": ra } : {} }
      );
    }
    return Response.json({ error: detail }, { status: 502 });
  }
  const text = (j.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  return Response.json({ text });
}
