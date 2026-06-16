export const runtime = "nodejs";
export const maxDuration = 60;

const PROMPT = `Tu lis un document de pharmacie (bon de livraison grossiste CERP, ou état de réception Winpharma).
Renvoie UNIQUEMENT du JSON valide et compact, sans aucun texte autour ni balises Markdown.

Schéma à clés courtes, à respecter exactement :
{"t":"BL"|"WP"|"X","T":nombre|null,"L":[{"c":"chiffres du code|null","d":"désignation","q":nombre,"p":nombre|null,"m":nombre|null}]}

t = type du document.
T = total HT imprimé du document (sinon null).
L = une entrée par ligne produit. Pour chaque ligne :
  c = uniquement les chiffres du code produit (CIP13/EAN), sans espaces ni lettres ; null si absent.
  d = désignation, raccourcie à ~30 caractères maximum si elle est longue.
  q = quantité réellement livrée/reçue (jamais la quantité commandée/annoncée si les deux figurent).
  p = prix unitaire HT net de la ligne ; null si absent.
  m = montant HT de la ligne tel qu'imprimé ; null si absent.

Impératifs : extrais CHAQUE ligne. N'invente aucune valeur (null si illisible). Nombres au
format français ("1 234,56") renvoyés en nombres JSON standard (1234.56). Aucune autre clé.`;

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "requête invalide" }, { status: 400 });
  }

  const { data, mediaType, isPdf, password } = body || {};

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
        messages: [{ role: "user", content: [block, { type: "text", text: PROMPT }] }],
      }),
    });
  } catch {
    return Response.json({ error: "service de lecture injoignable" }, { status: 502 });
  }

  const j = await r.json().catch(() => null);
  if (!r.ok || !j) {
    const detail = j && j.error && j.error.message ? j.error.message : "erreur du service de lecture";
    return Response.json({ error: detail }, { status: 502 });
  }

  const text = (j.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  return Response.json({ text });
}
