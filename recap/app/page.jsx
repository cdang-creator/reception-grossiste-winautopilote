"use client";

import React, { useState, useRef } from "react";

/* ------------------------------------------------------------------ */
/*  Préparation des fichiers                                           */
/* ------------------------------------------------------------------ */

/* Réduit les images trop lourdes pour rester sous la limite de requête (4,5 Mo) */
function downscaleImage(file, maxSide = 2200, quality = 0.85) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      c.getContext("2d").drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      res({ data: c.toDataURL("image/jpeg", quality).split(",")[1], mediaType: "image/jpeg" });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      rej(new Error("Image illisible : " + file.name));
    };
    img.src = url;
  });
}

/* Limite de corps de requête Vercel ≈ 4,5 Mo ; on vise ~3,3 Mo brut (≈4,4 Mo encodé). */
const MAX_RAW = 2_900_000;
const MAX_PAGES = 2;

function uint8ToB64(u8) {
  let s = "";
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  }
  return btoa(s);
}

/* Découpe un gros PDF en paquets de pages, chacun sous la limite. */
async function splitPdfToChunks(arrayBuffer) {
  const { PDFDocument } = await import("pdf-lib");
  const src = await PDFDocument.load(arrayBuffer, { ignoreEncryption: true });
  const n = src.getPageCount();
  if (!n) throw new Error("PDF vide ou illisible.");

  // 1) taille individuelle de chaque page
  const sizes = [];
  for (let i = 0; i < n; i++) {
    const one = await PDFDocument.create();
    const [pg] = await one.copyPages(src, [i]);
    one.addPage(pg);
    sizes.push((await one.save({ useObjectStreams: true })).length);
  }

  // 2) regroupement glouton sous la limite (la taille combinée ≤ somme des pages)
  const groups = [];
  let cur = [];
  let curSize = 0;
  for (let i = 0; i < n; i++) {
    if (cur.length && (curSize + sizes[i] > MAX_RAW || cur.length >= MAX_PAGES)) {
      groups.push(cur);
      cur = [];
      curSize = 0;
    }
    cur.push(i);
    curSize += sizes[i];
  }
  if (cur.length) groups.push(cur);

  // 3) sérialisation de chaque paquet
  const chunks = [];
  for (const g of groups) {
    const out = await PDFDocument.create();
    const cp = await out.copyPages(src, g);
    cp.forEach((p) => out.addPage(p));
    chunks.push(uint8ToB64(await out.save({ useObjectStreams: true })));
  }
  return chunks;
}

/* Renvoie une liste de charges utiles {data, mediaType, isPdf}, chacune sous la limite. */
async function prepareChunks(file) {
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  if (isPdf) {
    const buf = await file.arrayBuffer();
    const parts = await splitPdfToChunks(buf);
    return parts.map((d) => ({ data: d, mediaType: "application/pdf", isPdf: true }));
  }
  const { data, mediaType } = await downscaleImage(file);
  return [{ data, mediaType, isPdf: false }];
}

/* ------------------------------------------------------------------ */
/*  Lecture (via backend) + parsing robuste                            */
/* ------------------------------------------------------------------ */

function stripFences(text) {
  return text.replace(/```json/gi, "").replace(/```/g, "").trim();
}

function repairJson(raw) {
  const lastObj = raw.lastIndexOf("}");
  if (lastObj === -1) throw new Error("réponse illisible");
  return JSON.parse(raw.slice(0, lastObj + 1).trim() + "]}");
}

function normalizeDoc(p, repaired) {
  const src = p.L || p.lignes || [];
  const lignes = src.map((l) => ({
    code: l.c != null ? l.c : l.code,
    designation: l.d != null ? l.d : l.designation,
    qte: l.q != null ? l.q : l.qte,
    pu_ht: l.p != null ? l.p : l.pu_ht,
    montant_ht: l.m != null ? l.m : l.montant_ht,
  }));
  const total =
    typeof p.T === "number" ? p.T : typeof p.total_ht === "number" ? p.total_ht : null;
  return { type: p.t || p.type || null, total_ht: total, lignes, _repaired: !!repaired };
}

class PasswordError extends Error {}

async function extractChunk(payload, password) {
  const MAX_TRIES = 5;
  let lastWhy = "lecture impossible";
  for (let t = 0; t < MAX_TRIES; t++) {
    if (t > 0) {
      const wait = Math.min(12000, 1000 * Math.pow(2, t - 1)) + Math.floor(Math.random() * 600);
      await new Promise((res) => setTimeout(res, wait));
    }
    let r, j;
    try {
      r = await fetch("/api/extract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...payload, password: password || "" }),
      });
      j = await r.json().catch(() => ({}));
    } catch {
      lastWhy = "réseau injoignable";
      continue; // erreur réseau → on réessaie
    }
    if (r.status === 401) throw new PasswordError("mot de passe");
    if (r.ok) {
      const raw = stripFences(j.text || "");
      try {
        return normalizeDoc(JSON.parse(raw), false);
      } catch {
        try {
          return normalizeDoc(repairJson(raw), true);
        } catch {
          lastWhy = "scan peu net";
          continue; // JSON cassé → un nouvel essai peut mieux lire
        }
      }
    }
    // réponse en erreur
    if (r.status === 429 || r.status >= 500 || r.status === 408) {
      lastWhy =
        r.status === 429
          ? "trop de lectures simultanées"
          : r.status === 408
          ? "délai dépassé sur ce paquet"
          : "service de lecture momentanément indisponible";
      continue; // transitoire → backoff puis nouvel essai
    }
    // erreur définitive (4xx hors 408/429)
    throw new Error("Lecture impossible : " + (j.error || "erreur " + r.status));
  }
  throw new Error("Lecture impossible après plusieurs essais (" + lastWhy + ")");
}

/* Lit un fichier entier : le découpe, lit les paquets en parallèle, et ne s'arrête
   jamais sur un paquet récalcitrant — il est noté pour rescan, le reste continue. */
async function extractFile(file, password, onChunk) {
  const chunks = await prepareChunks(file);
  const docs = new Array(chunks.length);
  const failures = [];
  const CONCURRENCY = 2;
  let next = 0;
  let done = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= chunks.length) return;
      try {
        docs[i] = await extractChunk(chunks[i], password);
      } catch (e) {
        if (e instanceof PasswordError) throw e;
        docs[i] = { type: null, total_ht: null, lignes: [], _repaired: false, _failed: true };
        failures.push(i + 1);
      }
      done++;
      if (onChunk) onChunk(done, chunks.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, worker));
  return { docs, failures };
}

/* ------------------------------------------------------------------ */
/*  Calculs                                                            */
/* ------------------------------------------------------------------ */

const num = (x) => (typeof x === "number" && isFinite(x) ? x : 0);
const normCode = (c) => (c == null ? "" : String(c).replace(/\D/g, ""));
const eur = (n) =>
  (Math.round(n * 100) / 100).toLocaleString("fr-FR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }) + " €";
const qty = (n) =>
  Number.isInteger(n) ? String(n) : n.toLocaleString("fr-FR", { maximumFractionDigits: 3 });

const parseFr = (v) => {
  const n = parseFloat(String(v).replace(/\s/g, "").replace(",", "."));
  return isFinite(n) ? n : 0;
};
const fmtEdit = (n) =>
  n == null ? "" : (Math.round(n * 100) / 100).toString().replace(".", ",");
const lineMontant = (l) =>
  typeof l.montant_ht === "number"
    ? l.montant_ht
    : typeof l.pu_ht === "number"
    ? l.pu_ht * num(l.qte)
    : 0;
const docSum = (doc) => (doc.lignes || []).reduce((s, l) => s + lineMontant(l), 0);

function aggregate(docs) {
  const map = new Map();
  let stated = 0;
  let hasStated = false;
  for (const d of docs) {
    if (typeof d.total_ht === "number") {
      stated += d.total_ht;
      hasStated = true;
    }
    for (const l of d.lignes || []) {
      const code = normCode(l.code);
      const key = code || "DES:" + String(l.designation || "").trim().toLowerCase();
      const prev = map.get(key) || {
        code,
        designation: l.designation || "",
        qte: 0,
        montant: 0,
        puKnown: false,
      };
      const q = num(l.qte);
      let montant;
      if (typeof l.montant_ht === "number") montant = l.montant_ht;
      else if (typeof l.pu_ht === "number") montant = l.pu_ht * q;
      else montant = 0;
      if (typeof l.pu_ht === "number" || typeof l.montant_ht === "number") prev.puKnown = true;
      prev.qte += q;
      prev.montant += montant;
      if (!prev.designation && l.designation) prev.designation = l.designation;
      map.set(key, prev);
    }
  }
  for (const v of map.values()) v.pu = v.qte ? v.montant / v.qte : 0;
  const sumLines = [...map.values()].reduce((s, v) => s + v.montant, 0);
  return { map, sumLines, statedTotal: hasStated ? stated : null };
}

function reconcile(bl, wp) {
  const keys = new Set([...bl.map.keys(), ...wp.map.keys()]);
  const rows = [];
  let partQte = 0;
  let partPrix = 0;
  for (const k of keys) {
    const b = bl.map.get(k);
    const w = wp.map.get(k);
    const qteBL = b ? b.qte : 0;
    const qteWP = w ? w.qte : 0;
    const puBL = b ? b.pu : w ? w.pu : 0;
    const puWP = w ? w.pu : b ? b.pu : 0;
    const montantBL = b ? b.montant : 0;
    const montantWP = w ? w.montant : 0;
    const refPu = b ? b.pu : puWP;
    partQte += (qteWP - qteBL) * refPu;
    partPrix += qteWP * (puWP - puBL);
    rows.push({
      code: (b && b.code) || (w && w.code) || "",
      designation: (b && b.designation) || (w && w.designation) || "—",
      qteBL,
      qteWP,
      puBL,
      puWP,
      montantBL,
      montantWP,
      inBL: !!b,
      inWP: !!w,
    });
  }
  const totalBL = bl.sumLines;
  const totalWP = wp.sumLines;
  const ecart = totalWP - totalBL;
  const r2 = (n) => Math.round(n * 100) / 100;
  return {
    totalBL,
    totalWP,
    ecart,
    partQte,
    partPrix,
    concordance: Math.abs(ecart) < 0.01,
    pricesMissing: totalBL === 0 && totalWP === 0,
    qtyEcarts: rows.filter((r) => r.inBL && r.inWP && r.qteBL !== r.qteWP),
    priceEcarts: rows.filter((r) => r.inBL && r.inWP && r2(r.puBL) !== r2(r.puWP)),
    blOnly: rows.filter((r) => !r.inWP),
    wpOnly: rows.filter((r) => !r.inBL),
  };
}

/* ------------------------------------------------------------------ */
/*  Composant                                                          */
/* ------------------------------------------------------------------ */

export default function Page() {
  const [blFiles, setBlFiles] = useState([]);
  const [wpFiles, setWpFiles] = useState([]);
  const [status, setStatus] = useState("idle");
  const [progress, setProgress] = useState("");
  const [result, setResult] = useState(null);
  const [extractions, setExtractions] = useState(null);
  const [error, setError] = useState("");
  const [showDetail, setShowDetail] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [blDocs, setBlDocs] = useState(null);
  const [wpDocs, setWpDocs] = useState(null);
  const [password, setPassword] = useState("");
  const [needPassword, setNeedPassword] = useState(false);
  const [notice, setNotice] = useState("");

  const addFiles = (side, list) => {
    const arr = Array.from(list).filter(
      (f) => f.type === "application/pdf" || f.type.startsWith("image/") || /\.pdf$/i.test(f.name)
    );
    if (side === "bl") setBlFiles((p) => [...p, ...arr]);
    else setWpFiles((p) => [...p, ...arr]);
    setStatus("idle");
    setResult(null);
    setError("");
  };

  const run = async () => {
    setError("");
    setResult(null);
    setTruncated(false);
    setNotice("");
    setStatus("reading");
    try {
      let failed = 0;
      const blDocs = [];
      for (let i = 0; i < blFiles.length; i++) {
        const part = blFiles.length > 1 ? ` (${i + 1}/${blFiles.length})` : "";
        const got = await extractFile(blFiles[i], password, (c, t) =>
          setProgress(
            t > 1
              ? `Lecture des BL CERP${part} — paquet ${c}/${t}`
              : `Lecture des BL CERP${part}`
          )
        );
        blDocs.push(...got.docs);
        failed += got.failures.length;
      }
      const wpDocs = [];
      for (let i = 0; i < wpFiles.length; i++) {
        const part = wpFiles.length > 1 ? ` (${i + 1}/${wpFiles.length})` : "";
        const got = await extractFile(wpFiles[i], password, (c, t) =>
          setProgress(
            t > 1
              ? `Lecture Winpharma${part} — paquet ${c}/${t}`
              : `Lecture de la réception Winpharma${part}`
          )
        );
        wpDocs.push(...got.docs);
        failed += got.failures.length;
      }
      setProgress("Comparaison…");
      setBlDocs(blDocs);
      setWpDocs(wpDocs);
      const blAgg = aggregate(blDocs);
      const wpAgg = aggregate(wpDocs);
      setExtractions({ bl: blAgg, wp: wpAgg });
      setTruncated([...blDocs, ...wpDocs].some((d) => d._repaired));
      setResult(reconcile(blAgg, wpAgg));
      setNotice(
        failed > 0
          ? `${failed} paquet(s) (≈${failed * 2} pages) n'ont pas pu être lus, même après plusieurs essais. Le résultat ci-dessous est PARTIEL : rescannez ces pages (plus net / niveaux de gris) et relancez.`
          : ""
      );
      const mismatch =
        (blAgg.statedTotal != null &&
          Math.abs(blAgg.statedTotal - blAgg.sumLines) >= 0.02) ||
        (wpAgg.statedTotal != null &&
          Math.abs(wpAgg.statedTotal - wpAgg.sumLines) >= 0.02);
      setShowDetail(mismatch);
      setNeedPassword(false);
      setStatus("done");
    } catch (e) {
      if (e instanceof PasswordError) {
        setNeedPassword(true);
        setError("Cet outil est protégé : entrez le mot de passe puis relancez.");
      } else {
        setError(e && e.message ? e.message : "La lecture a échoué. Réessayez avec un scan plus net.");
      }
      setStatus("error");
    }
  };

  const reset = () => {
    setBlFiles([]);
    setWpFiles([]);
    setResult(null);
    setExtractions(null);
    setError("");
    setTruncated(false);
    setNotice("");
    setBlDocs(null);
    setWpDocs(null);
    setShowDetail(false);
    setStatus("idle");
  };

  const recompute = (bdocs, wdocs) => {
    const blAgg = aggregate(bdocs);
    const wpAgg = aggregate(wdocs);
    setExtractions({ bl: blAgg, wp: wpAgg });
    setResult(reconcile(blAgg, wpAgg));
  };

  const editLine = (side, di, li, field, value) => {
    const v = parseFr(value);
    const src = side === "bl" ? blDocs : wpDocs;
    if (!src) return;
    const docs = src.map((d, i) =>
      i !== di
        ? d
        : { ...d, lignes: d.lignes.map((l, j) => (j === li ? { ...l, [field]: v } : l)) }
    );
    if (side === "bl") {
      setBlDocs(docs);
      recompute(docs, wpDocs);
    } else {
      setWpDocs(docs);
      recompute(blDocs, docs);
    }
  };

  const canRun = blFiles.length > 0 && wpFiles.length > 0 && status !== "reading";

  const issues = result
    ? [
        {
          key: "qty",
          title: "Écarts de quantité",
          action:
            "Manque livré → réclamer un avoir à CERP. Surplus reçu → vérifier et signaler.",
          impact: result.qtyEcarts.reduce(
            (s, r) => s + Math.abs((r.qteWP - r.qteBL) * (r.puBL || r.puWP)),
            0
          ),
          rows: result.qtyEcarts,
          cols: [
            ["Produit", (r) => r.designation, "left"],
            ["Code", (r) => r.code || "—", "left mono"],
            ["Qté BL", (r) => qty(r.qteBL), "num"],
            ["Qté reçue", (r) => qty(r.qteWP), "num"],
            ["Écart", (r) => qty(r.qteWP - r.qteBL), "num strong"],
            ["Impact €", (r) => eur((r.qteWP - r.qteBL) * (r.puBL || r.puWP)), "num"],
          ],
        },
        {
          key: "price",
          title: "Écarts de prix",
          action:
            "Prix facturé ≠ prix attendu → corriger le tarif / la remise dans Winpharma. Sinon ça se répète à chaque commande.",
          impact: result.priceEcarts.reduce(
            (s, r) => s + Math.abs(r.qteWP * (r.puWP - r.puBL)),
            0
          ),
          rows: result.priceEcarts,
          cols: [
            ["Produit", (r) => r.designation, "left"],
            ["Code", (r) => r.code || "—", "left mono"],
            ["Prix BL", (r) => eur(r.puBL), "num"],
            ["Prix Winpharma", (r) => eur(r.puWP), "num"],
            ["Écart unit.", (r) => eur(r.puWP - r.puBL), "num strong"],
            ["Impact €", (r) => eur(r.qteWP * (r.puWP - r.puBL)), "num"],
          ],
        },
        {
          key: "blonly",
          title: "Présent au BL, absent de la réception",
          action:
            "Sur le BL mais pas enregistré reçu → vérifier physiquement ; réclamer à CERP si non livré.",
          impact: result.blOnly.reduce((s, r) => s + Math.abs(r.montantBL), 0),
          rows: result.blOnly,
          cols: [
            ["Produit", (r) => r.designation, "left"],
            ["Code", (r) => r.code || "—", "left mono"],
            ["Qté BL", (r) => qty(r.qteBL), "num"],
            ["Montant BL", (r) => eur(r.montantBL), "num strong"],
          ],
        },
        {
          key: "wponly",
          title: "Reçu mais absent du BL",
          action:
            "Reçu sans BL → vérifier le colis. Présent = un BL à scanner. Absent = corriger la réception dans Winpharma.",
          impact: result.wpOnly.reduce((s, r) => s + Math.abs(r.montantWP), 0),
          rows: result.wpOnly,
          cols: [
            ["Produit", (r) => r.designation, "left"],
            ["Code", (r) => r.code || "—", "left mono"],
            ["Qté reçue", (r) => qty(r.qteWP), "num"],
            ["Montant", (r) => eur(r.montantWP), "num strong"],
          ],
        },
      ]
        .filter((i) => i.rows.length > 0)
        .sort((a, b) => b.impact - a.impact)
    : [];

  return (
    <div className="rcp-root">
      <style>{CSS}</style>

      <header className="rcp-head">
        <div className="rcp-eyebrow">Contrôle réception · officine</div>
        <h1 className="rcp-title">BL CERP&nbsp;↔&nbsp;Réception Winpharma</h1>
        <p className="rcp-sub">
          Déposez les bons de livraison CERP et l'état de réception Winpharma. L'outil compare les
          montants ; en cas d'écart, il trouve les lignes qui l'expliquent.
        </p>
      </header>

      <div className="rcp-zones">
        <DropZone
          label="Bons de livraison CERP"
          hint="Un ou plusieurs scans (PDF ou photo)"
          files={blFiles}
          onAdd={(l) => addFiles("bl", l)}
          onRemove={(i) => setBlFiles((p) => p.filter((_, k) => k !== i))}
          tone="brand"
        />
        <DropZone
          label="Réception Winpharma"
          hint="L'état de réception WinAutopilote (PDF ou capture)"
          files={wpFiles}
          onAdd={(l) => addFiles("wp", l)}
          onRemove={(i) => setWpFiles((p) => p.filter((_, k) => k !== i))}
          tone="ink"
        />
      </div>

      {needPassword && (
        <div className="rcp-pwd">
          <input
            type="password"
            placeholder="Mot de passe"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="rcp-pwd-input"
          />
        </div>
      )}

      <div className="rcp-actions">
        <button className="rcp-btn" onClick={run} disabled={!canRun}>
          {status === "reading" ? "Lecture en cours…" : "Comparer"}
        </button>
        {(blFiles.length > 0 || wpFiles.length > 0) && (
          <button className="rcp-btn ghost" onClick={reset} disabled={status === "reading"}>
            Réinitialiser
          </button>
        )}
        <span className="rcp-privacy">Lecture par l'IA, le temps de l'analyse.</span>
      </div>

      {status === "reading" && (
        <div className="rcp-loading" role="status" aria-live="polite">
          <span className="rcp-spin" aria-hidden="true" />
          {progress}
        </div>
      )}

      {error && (
        <div className="rcp-error" role="alert">
          {error}
        </div>
      )}

      {result && (
        <div className="rcp-result">
          {result.pricesMissing ? (
            <div className="rcp-verdict warn" role="status">
              <span className="rcp-verdict-icon" aria-hidden="true">!</span>
              <div className="rcp-verdict-body">
                <div className="rcp-verdict-main">Prix non détectés</div>
                <div className="rcp-verdict-sub">
                  Impossible de comparer les montants. Vérifiez que les scans montrent les prix, ou
                  regardez les quantités dans le détail ci-dessous.
                </div>
              </div>
            </div>
          ) : result.concordance ? (
            <div className="rcp-verdict ok" role="status">
              <span className="rcp-verdict-icon" aria-hidden="true">✓</span>
              <div className="rcp-verdict-body">
                <div className="rcp-verdict-main">Les montants concordent</div>
                <div className="rcp-verdict-sub">
                  Rien à faire. Total BL <b className="num">{eur(result.totalBL)}</b> · Reçu Winpharma{" "}
                  <b className="num">{eur(result.totalWP)}</b>
                </div>
              </div>
            </div>
          ) : (
            <div className="rcp-verdict bad" role="status">
              <span className="rcp-verdict-icon" aria-hidden="true">✗</span>
              <div className="rcp-verdict-body">
                <div className="rcp-verdict-label">Écart à traiter</div>
                <div className="rcp-verdict-amount num">{eur(Math.abs(result.ecart))}</div>
                <div className="rcp-verdict-sub">
                  Total BL <b className="num">{eur(result.totalBL)}</b> · Reçu Winpharma{" "}
                  <b className="num">{eur(result.totalWP)}</b>
                  {" — "}
                  {result.ecart > 0
                    ? "Winpharma supérieur (ce n'est pas un manquant CERP)"
                    : "BL supérieur (manque côté reçu)"}
                </div>
                <div className="rcp-chips">
                  <span className="rcp-chip">
                    dont quantité <b className="num">{eur(result.partQte)}</b>
                  </span>
                  <span className="rcp-chip">
                    dont prix <b className="num">{eur(result.partPrix)}</b>
                  </span>
                </div>
              </div>
            </div>
          )}

          {notice && (
            <div className="rcp-integrity" role="alert">
              ⚠ {notice}
            </div>
          )}

          {truncated && (
            <div className="rcp-integrity" role="alert">
              ⚠ Un document était trop long : la lecture a été tronquée et des lignes ont pu être
              perdues. Le total peut être incomplet — vérifiez le détail, ou scannez le BL en deux
              fichiers et relancez.
            </div>
          )}

          <IntegrityCheck side="BL CERP" agg={extractions.bl} />
          <IntegrityCheck side="Réception Winpharma" agg={extractions.wp} />

          {issues.length > 0 && (
            <div className="rcp-section-head">À traiter — classé par impact</div>
          )}
          {issues.map((iss) => (
            <EcartTable
              key={iss.key}
              title={iss.title}
              action={iss.action}
              impact={iss.impact}
              rows={iss.rows}
              cols={iss.cols}
            />
          ))}

          <button className="rcp-detail-toggle" onClick={() => setShowDetail((s) => !s)}>
            {showDetail ? "Masquer" : "Voir"} le détail des lignes lues
          </button>
          {showDetail && blDocs && wpDocs && (
            <div className="rcp-detail">
              <p className="rcp-edit-hint">
                Une valeur mal lue ? Clique le chiffre, tape le bon (la virgule marche), sors du
                champ : le total et la comparaison se recalculent. Vise « lignes = total » sur
                chaque document.
              </p>
              <EditableDetail side="bl" label="BL CERP" docs={blDocs} onEdit={editLine} />
              <EditableDetail
                side="wp"
                label="Réception Winpharma"
                docs={wpDocs}
                onEdit={editLine}
              />
            </div>
          )}
        </div>
      )}

      <footer className="rcp-foot">Contrôle de première passe — vérifiez le détail avant toute réclamation.</footer>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Sous-composants                                                    */
/* ------------------------------------------------------------------ */

function DropZone({ label, hint, files, onAdd, onRemove, tone }) {
  const [over, setOver] = useState(false);
  const inputRef = useRef(null);
  return (
    <div
      className={"rcp-zone " + tone + (over ? " over" : "")}
      role="button"
      tabIndex={0}
      aria-label={label + " — ajouter des fichiers"}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          inputRef.current && inputRef.current.click();
        }
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        onAdd(e.dataTransfer.files);
      }}
      onClick={() => inputRef.current && inputRef.current.click()}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,image/*"
        multiple
        style={{ display: "none" }}
        onChange={(e) => onAdd(e.target.files)}
      />
      <div className="rcp-zone-label">{label}</div>
      <div className="rcp-zone-hint">{hint}</div>
      <div className="rcp-zone-cta">Cliquez ou glissez vos fichiers</div>
      {files.length > 0 && (
        <ul className="rcp-files" onClick={(e) => e.stopPropagation()}>
          {files.map((f, i) => (
            <li key={i}>
              <span className="rcp-file-name">{f.name}</span>
              <button className="rcp-file-x" onClick={() => onRemove(i)} aria-label="Retirer">
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function IntegrityCheck({ side, agg }) {
  if (agg.statedTotal == null) return null;
  const diff = agg.statedTotal - agg.sumLines;
  if (Math.abs(diff) < 0.02) return null;
  return (
    <div className="rcp-integrity" role="alert">
      ⚠ {side} : le total imprimé (<span className="num">{eur(agg.statedTotal)}</span>) ne colle pas
      à la somme des lignes lues (<span className="num">{eur(agg.sumLines)}</span>). Une ligne a
      peut-être été mal lue — vérifiez le détail avant de conclure.
    </div>
  );
}

function EcartTable({ title, rows, cols, action, impact }) {
  if (!rows || rows.length === 0) return null;
  return (
    <section className="rcp-issue">
      <div className="rcp-issue-head">
        <h3 className="rcp-issue-title">
          {title} <span className="rcp-count">{rows.length}</span>
        </h3>
        {typeof impact === "number" && (
          <span className="rcp-impact num">{eur(Math.abs(impact))}</span>
        )}
      </div>
      {action && <p className="rcp-action">{action}</p>}
      <div className="rcp-table-wrap">
        <table className="rcp-table">
          <thead>
            <tr>
              {cols.map((c, i) => (
                <th key={i} scope="col" className={c[2].includes("num") ? "ta-r" : "ta-l"}>
                  {c[0]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri}>
                {cols.map((c, ci) => (
                  <td
                    key={ci}
                    className={
                      (c[2].includes("num") ? "ta-r num " : "ta-l ") +
                      (c[2].includes("mono") ? "mono " : "") +
                      (c[2].includes("strong") ? "strong" : "")
                    }
                  >
                    {c[1](r)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function EditableDetail({ side, label, docs, onEdit }) {
  return (
    <>
      {docs.map((doc, di) => {
        const sum = docSum(doc);
        const stated = typeof doc.total_ht === "number" ? doc.total_ht : null;
        const gap = stated != null ? stated - sum : null;
        const matched = gap != null && Math.abs(gap) < 0.02;
        return (
          <section className="rcp-issue" key={di}>
            <div className="rcp-issue-head">
              <h3 className="rcp-issue-title">
                {label}
                {docs.length > 1 ? " " + (di + 1) : ""}
                {doc._repaired && <span className="rcp-tag">lecture tronquée</span>}
              </h3>
              {stated != null && (
                <span className={matched ? "rcp-doc-ok" : "rcp-doc-gap"}>
                  {matched ? "✓ lignes = total" : "écart " + eur(gap)}
                </span>
              )}
            </div>
            <div className="rcp-table-wrap">
              <table className="rcp-table small">
                <thead>
                  <tr>
                    <th scope="col" className="ta-l">Produit</th>
                    <th scope="col" className="ta-l">Code</th>
                    <th scope="col" className="ta-r">Qté</th>
                    <th scope="col" className="ta-r">Montant HT</th>
                  </tr>
                </thead>
                <tbody>
                  {doc.lignes.map((l, li) => (
                    <tr key={li}>
                      <td className="ta-l">{l.designation || "—"}</td>
                      <td className="ta-l mono">{normCode(l.code) || "—"}</td>
                      <td className="ta-r">
                        <input
                          className="rcp-edit"
                          type="text"
                          inputMode="decimal"
                          defaultValue={fmtEdit(num(l.qte))}
                          aria-label={"Quantité — " + (l.designation || "ligne")}
                          onBlur={(e) => onEdit(side, di, li, "qte", e.target.value)}
                        />
                      </td>
                      <td className="ta-r">
                        <input
                          className="rcp-edit"
                          type="text"
                          inputMode="decimal"
                          defaultValue={fmtEdit(lineMontant(l))}
                          aria-label={"Montant HT — " + (l.designation || "ligne")}
                          onBlur={(e) => onEdit(side, di, li, "montant_ht", e.target.value)}
                        />
                      </td>
                    </tr>
                  ))}
                  <tr className="rcp-total-row">
                    <td className="ta-l strong" colSpan={3}>
                      {stated != null ? "Lignes lues / total imprimé" : "Total des lignes lues"}
                    </td>
                    <td className="ta-r num strong">
                      {eur(sum)}
                      {stated != null ? " / " + eur(stated) : ""}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Styles                                                             */
/* ------------------------------------------------------------------ */

const CSS = `
.rcp-root{
  --bg:#EEF1F0; --card:#FFFFFF; --ink:#15211F; --muted:#5C6B68;
  --line:#DCE3E1; --brand:#0F766E; --brand-soft:#E3F1EE;
  --ok:#15803D; --ok-soft:#E7F4EC; --warn:#B45309; --warn-soft:#FBF0E2;
  --bad:#B91C1C; --bad-soft:#FBEAEA;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  color:var(--ink); background:var(--bg); padding:28px clamp(14px,4vw,40px) 40px;
  min-height:100vh; -webkit-font-smoothing:antialiased;
}
.rcp-root *{box-sizing:border-box;}
.num{font-variant-numeric:tabular-nums; font-feature-settings:"tnum" 1;}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:.88em; letter-spacing:-.01em;}
.strong{font-weight:650;}
.ta-r{text-align:right;} .ta-l{text-align:left;}

.rcp-head{max-width:880px; margin:0 auto 22px;}
.rcp-eyebrow{font-size:11px; letter-spacing:.16em; text-transform:uppercase; color:var(--brand); font-weight:650;}
.rcp-title{font-size:clamp(22px,3.4vw,30px); font-weight:700; letter-spacing:-.02em; margin:6px 0 8px;}
.rcp-sub{color:var(--muted); font-size:15px; line-height:1.5; margin:0; max-width:60ch;}

.rcp-zones{max-width:880px; margin:0 auto; display:grid; grid-template-columns:1fr 1fr; gap:14px;}
@media(max-width:620px){.rcp-zones{grid-template-columns:1fr;}}
.rcp-zone{
  background:var(--card); border:1.5px dashed var(--line); border-radius:14px;
  padding:20px 18px; cursor:pointer; transition:border-color .15s,background .15s; position:relative;
}
.rcp-zone:hover{border-color:var(--brand);}
.rcp-zone.over{border-color:var(--brand); background:var(--brand-soft); border-style:solid;}
.rcp-zone.brand .rcp-zone-label{color:var(--brand);}
.rcp-zone-label{font-weight:650; font-size:15px; margin-bottom:2px;}
.rcp-zone-hint{font-size:13px; color:var(--muted); margin-bottom:14px;}
.rcp-zone-cta{font-size:13px; color:var(--muted); border-top:1px solid var(--line); padding-top:12px;}
.rcp-files{list-style:none; margin:12px 0 0; padding:0; display:flex; flex-direction:column; gap:6px;}
.rcp-files li{display:flex; align-items:center; gap:8px; background:var(--bg); border-radius:8px; padding:6px 10px; font-size:13px;}
.rcp-file-name{flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
.rcp-file-x{border:none; background:none; color:var(--muted); font-size:18px; line-height:1; cursor:pointer; padding:0 2px;}
.rcp-file-x:hover{color:var(--bad);}

.rcp-pwd{max-width:880px; margin:14px auto 0;}
.rcp-pwd-input{padding:10px 14px; border:1px solid var(--line); border-radius:10px; font-size:14px; width:220px;}
.rcp-pwd-input:focus{outline:2px solid var(--brand); outline-offset:1px; border-color:var(--brand);}

.rcp-actions{max-width:880px; margin:18px auto 0; display:flex; align-items:center; gap:12px; flex-wrap:wrap;}
.rcp-btn{background:var(--brand); color:#fff; border:none; border-radius:10px; padding:12px 26px; font-size:15px; font-weight:650; cursor:pointer; transition:opacity .15s,transform .05s;}
.rcp-btn:hover:not(:disabled){opacity:.92;}
.rcp-btn:active:not(:disabled){transform:translateY(1px);}
.rcp-btn:disabled{opacity:.4; cursor:not-allowed;}
.rcp-btn.ghost{background:none; color:var(--muted); border:1px solid var(--line);}
.rcp-privacy{font-size:12px; color:var(--muted); flex:1; min-width:200px;}

.rcp-loading{max-width:880px; margin:22px auto 0; display:flex; align-items:center; gap:12px; color:var(--muted); font-size:14px;}
.rcp-spin{width:18px; height:18px; border:2.5px solid var(--line); border-top-color:var(--brand); border-radius:50%; animation:rcp-rot .7s linear infinite;}
@keyframes rcp-rot{to{transform:rotate(360deg);}}

.rcp-error{max-width:880px; margin:22px auto 0; background:var(--bad-soft); color:var(--bad); border-radius:12px; padding:14px 18px; font-size:14px;}

.rcp-result{max-width:880px; margin:26px auto 0; animation:rcp-in .35s ease both;}
@keyframes rcp-in{from{opacity:0; transform:translateY(8px);} to{opacity:1; transform:none;}}

.rcp-verdict{border-radius:16px; padding:22px 24px; margin-bottom:18px;}
.rcp-verdict.ok{background:var(--ok-soft); border:1px solid #BFE3CB;}
.rcp-verdict.bad{background:var(--bad-soft); border:1px solid #F0C9C9;}
.rcp-verdict.warn{background:var(--warn-soft); border:1px solid #EAD2AE;}
.rcp-verdict-main{font-size:clamp(20px,3vw,26px); font-weight:700; letter-spacing:-.02em;}
.rcp-verdict.ok .rcp-verdict-main{color:var(--ok);}
.rcp-verdict.bad .rcp-verdict-main{color:var(--bad);}
.rcp-verdict.warn .rcp-verdict-main{color:var(--warn);}
.rcp-verdict-sub{margin-top:6px; color:var(--ink); font-size:14px;}
.rcp-chips{margin-top:14px; display:flex; gap:10px; flex-wrap:wrap;}
.rcp-chip{background:#fff; border:1px solid var(--line); border-radius:999px; padding:6px 14px; font-size:13px; color:var(--muted);}
.rcp-chip b{color:var(--ink); margin-left:4px;}

.rcp-integrity{background:var(--warn-soft); border:1px solid #EAD2AE; color:var(--warn); border-radius:12px; padding:12px 16px; font-size:13.5px; margin-bottom:14px; line-height:1.45;}

.rcp-table-block{background:var(--card); border:1px solid var(--line); border-radius:14px; padding:16px 18px; margin-bottom:14px;}
.rcp-table-title{font-size:15px; font-weight:650; margin:0 0 10px; display:flex; align-items:center; gap:8px;}
.rcp-count{background:var(--bg); border-radius:999px; padding:1px 9px; font-size:12px; color:var(--muted); font-weight:600;}
.rcp-empty{color:var(--muted); font-size:13.5px; margin:0;}
.rcp-table-wrap{overflow-x:auto;}
.rcp-table{width:100%; border-collapse:collapse; font-size:13.5px;}
.rcp-table.small{font-size:12.5px;}
.rcp-table th{color:var(--muted); font-weight:600; font-size:12px; text-transform:uppercase; letter-spacing:.04em; padding:0 10px 8px; border-bottom:1px solid var(--line); white-space:nowrap;}
.rcp-table td{padding:8px 10px; border-bottom:1px solid #EEF2F1; vertical-align:top;}
.rcp-table tbody tr:last-child td{border-bottom:none;}
.rcp-total-row td{border-top:1.5px solid var(--line); border-bottom:none !important; padding-top:10px;}

.rcp-detail-toggle{background:none; border:1px solid var(--line); border-radius:10px; padding:9px 16px; font-size:13px; color:var(--muted); cursor:pointer; margin-top:4px;}
.rcp-detail-toggle:hover{border-color:var(--brand); color:var(--brand);}
.rcp-detail{margin-top:14px;}

/* --- v2 : accessibilité, hiérarchie, action --- */
.rcp-zone:focus-visible{outline:3px solid var(--brand); outline-offset:2px; border-color:var(--brand);}
.rcp-btn:focus-visible,.rcp-detail-toggle:focus-visible,.rcp-file-x:focus-visible,.rcp-pwd-input:focus-visible{outline:3px solid var(--brand); outline-offset:2px;}
.rcp-file-x{min-width:32px; min-height:32px; display:inline-flex; align-items:center; justify-content:center; border-radius:8px;}

.rcp-verdict{display:flex; gap:16px; align-items:flex-start;}
.rcp-verdict-icon{flex:none; width:34px; height:34px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:18px; font-weight:800; color:#fff; margin-top:2px;}
.rcp-verdict.ok .rcp-verdict-icon{background:var(--ok);}
.rcp-verdict.bad .rcp-verdict-icon{background:var(--bad);}
.rcp-verdict.warn .rcp-verdict-icon{background:var(--warn);}
.rcp-verdict-body{flex:1; min-width:0;}
.rcp-verdict-label{font-size:12px; letter-spacing:.1em; text-transform:uppercase; font-weight:700; color:var(--bad);}
.rcp-verdict-amount{font-size:clamp(30px,6vw,44px); font-weight:800; letter-spacing:-.03em; color:var(--bad); line-height:1.04; margin-top:2px;}

.rcp-section-head{max-width:880px; font-size:12px; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); font-weight:700; margin:22px 0 10px;}
.rcp-issue{background:var(--card); border:1px solid var(--line); border-radius:14px; padding:16px 18px; margin-bottom:12px;}
.rcp-issue-head{display:flex; align-items:center; justify-content:space-between; gap:10px;}
.rcp-issue-title{font-size:15px; font-weight:650; margin:0; display:flex; align-items:center; gap:8px;}
.rcp-impact{font-size:15px; font-weight:700; color:var(--bad); background:var(--bad-soft); border-radius:8px; padding:3px 10px; white-space:nowrap;}
.rcp-action{font-size:13.5px; color:var(--ink); background:var(--bg); border-left:3px solid var(--brand); border-radius:0 8px 8px 0; padding:9px 12px; margin:10px 0 12px; line-height:1.45;}

@media (prefers-reduced-motion: reduce){
  .rcp-spin{animation:none;}
  .rcp-result{animation:none;}
}

.rcp-edit-hint{max-width:880px; font-size:13px; color:var(--ink); background:var(--brand-soft); border-radius:10px; padding:10px 14px; margin:0 0 12px; line-height:1.45;}
.rcp-edit{width:88px; text-align:right; font-variant-numeric:tabular-nums; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12.5px; padding:5px 7px; border:1px solid var(--line); border-radius:7px; background:#fff; color:var(--ink);}
.rcp-edit:hover{border-color:var(--brand);}
.rcp-edit:focus-visible{outline:2px solid var(--brand); outline-offset:1px; border-color:var(--brand);}
.rcp-doc-ok{font-size:12.5px; font-weight:700; color:var(--ok); background:var(--ok-soft); border-radius:8px; padding:3px 10px; white-space:nowrap;}
.rcp-doc-gap{font-size:12.5px; font-weight:700; color:var(--warn); background:var(--warn-soft); border-radius:8px; padding:3px 10px; white-space:nowrap;}
.rcp-tag{font-size:11px; font-weight:600; color:var(--warn); background:var(--warn-soft); border-radius:6px; padding:2px 7px; margin-left:8px;}

.rcp-foot{max-width:880px; margin:28px auto 0; font-size:12px; color:var(--muted); text-align:center;}
`;
