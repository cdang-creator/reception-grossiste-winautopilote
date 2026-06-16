"use client";

import React, { useState, useRef } from "react";

/* ------------------------------------------------------------------ */
/*  Préparation des fichiers                                           */
/* ------------------------------------------------------------------ */

function fileToBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1]);
    r.onerror = () => rej(new Error("Lecture du fichier impossible"));
    r.readAsDataURL(file);
  });
}

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

async function prepareFile(file) {
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  if (isPdf) {
    if (file.size > 4 * 1024 * 1024)
      throw new Error(
        "« " +
          file.name +
          " » dépasse 4 Mo. Scannez-le en noir et blanc / résolution plus basse, ou en deux fichiers."
      );
    return { data: await fileToBase64(file), mediaType: "application/pdf", isPdf: true };
  }
  const { data, mediaType } = await downscaleImage(file);
  return { data, mediaType, isPdf: false };
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

async function extractDoc(file, password) {
  const prepared = await prepareFile(file);
  const r = await fetch("/api/extract", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...prepared, password: password || "" }),
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) throw new PasswordError("mot de passe");
  if (!r.ok) throw new Error(j.error ? "Lecture impossible : " + j.error : "Lecture impossible.");
  const raw = stripFences(j.text || "");
  try {
    return normalizeDoc(JSON.parse(raw), false);
  } catch {
    try {
      return normalizeDoc(repairJson(raw), true);
    } catch {
      throw new Error(
        "Lecture impossible pour « " +
          file.name +
          " » (document trop long ou scan peu net). Scannez-le en deux fichiers et redéposez-les."
      );
    }
  }
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
  const [password, setPassword] = useState("");
  const [needPassword, setNeedPassword] = useState(false);

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
    setStatus("reading");
    try {
      const blDocs = [];
      for (let i = 0; i < blFiles.length; i++) {
        setProgress(`Lecture des BL CERP — ${i + 1}/${blFiles.length}`);
        blDocs.push(await extractDoc(blFiles[i], password));
      }
      const wpDocs = [];
      for (let i = 0; i < wpFiles.length; i++) {
        setProgress(`Lecture de la réception Winpharma — ${i + 1}/${wpFiles.length}`);
        wpDocs.push(await extractDoc(wpFiles[i], password));
      }
      setProgress("Comparaison…");
      const blAgg = aggregate(blDocs);
      const wpAgg = aggregate(wpDocs);
      setExtractions({ bl: blAgg, wp: wpAgg });
      setTruncated([...blDocs, ...wpDocs].some((d) => d._repaired));
      setResult(reconcile(blAgg, wpAgg));
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
    setStatus("idle");
  };

  const canRun = blFiles.length > 0 && wpFiles.length > 0 && status !== "reading";

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
        <span className="rcp-privacy">
          Les documents sont lus le temps de l'analyse. Rien n'est conservé.
        </span>
      </div>

      {status === "reading" && (
        <div className="rcp-loading">
          <span className="rcp-spin" />
          {progress}
        </div>
      )}

      {error && <div className="rcp-error">{error}</div>}

      {result && (
        <div className="rcp-result">
          {result.pricesMissing ? (
            <div className="rcp-verdict warn">
              <div className="rcp-verdict-main">Prix non détectés sur les documents</div>
              <div className="rcp-verdict-sub">
                Impossible de comparer les montants. Vérifiez que les scans montrent bien les prix,
                ou comparez en quantité dans le détail ci-dessous.
              </div>
            </div>
          ) : result.concordance ? (
            <div className="rcp-verdict ok">
              <div className="rcp-verdict-main">Les montants concordent</div>
              <div className="rcp-verdict-sub">
                Total BL <b className="num">{eur(result.totalBL)}</b> · Réception Winpharma{" "}
                <b className="num">{eur(result.totalWP)}</b>
              </div>
            </div>
          ) : (
            <div className="rcp-verdict bad">
              <div className="rcp-verdict-main">
                Écart de <span className="num">{eur(Math.abs(result.ecart))}</span>
              </div>
              <div className="rcp-verdict-sub">
                Total BL <b className="num">{eur(result.totalBL)}</b> · Réception Winpharma{" "}
                <b className="num">{eur(result.totalWP)}</b>
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
          )}

          {truncated && (
            <div className="rcp-integrity">
              ⚠ Un document était trop long : la lecture a été tronquée et des lignes ont pu être
              perdues. Le total peut être incomplet — vérifiez le détail, ou scannez le BL en deux
              fichiers et relancez.
            </div>
          )}

          <IntegrityCheck side="BL CERP" agg={extractions.bl} />
          <IntegrityCheck side="Réception Winpharma" agg={extractions.wp} />

          {!result.concordance && !result.pricesMissing && (
            <>
              <EcartTable
                title="Écarts de quantité"
                empty="Aucun écart de quantité."
                rows={result.qtyEcarts}
                cols={[
                  ["Produit", (r) => r.designation, "left"],
                  ["Code", (r) => r.code || "—", "left mono"],
                  ["Qté BL", (r) => qty(r.qteBL), "num"],
                  ["Qté reçue", (r) => qty(r.qteWP), "num"],
                  ["Écart", (r) => qty(r.qteWP - r.qteBL), "num strong"],
                  ["Impact €", (r) => eur((r.qteWP - r.qteBL) * (r.puBL || r.puWP)), "num"],
                ]}
              />
              <EcartTable
                title="Écarts de prix"
                empty="Aucun écart de prix."
                rows={result.priceEcarts}
                cols={[
                  ["Produit", (r) => r.designation, "left"],
                  ["Code", (r) => r.code || "—", "left mono"],
                  ["Prix BL", (r) => eur(r.puBL), "num"],
                  ["Prix Winpharma", (r) => eur(r.puWP), "num"],
                  ["Écart unit.", (r) => eur(r.puWP - r.puBL), "num strong"],
                  ["Impact €", (r) => eur(r.qteWP * (r.puWP - r.puBL)), "num"],
                ]}
              />
              <EcartTable
                title="Présent au BL, absent de la réception"
                empty="Aucun."
                rows={result.blOnly}
                cols={[
                  ["Produit", (r) => r.designation, "left"],
                  ["Code", (r) => r.code || "—", "left mono"],
                  ["Qté BL", (r) => qty(r.qteBL), "num"],
                  ["Montant BL", (r) => eur(r.montantBL), "num strong"],
                ]}
              />
              <EcartTable
                title="Reçu mais absent du BL"
                empty="Aucun."
                rows={result.wpOnly}
                cols={[
                  ["Produit", (r) => r.designation, "left"],
                  ["Code", (r) => r.code || "—", "left mono"],
                  ["Qté reçue", (r) => qty(r.qteWP), "num"],
                  ["Montant", (r) => eur(r.montantWP), "num strong"],
                ]}
              />
            </>
          )}

          <button className="rcp-detail-toggle" onClick={() => setShowDetail((s) => !s)}>
            {showDetail ? "Masquer" : "Voir"} le détail des lignes lues
          </button>
          {showDetail && (
            <div className="rcp-detail">
              <DetailTable title="Lignes lues — BL CERP" agg={extractions.bl} />
              <DetailTable title="Lignes lues — Réception Winpharma" agg={extractions.wp} />
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
      <div className="rcp-zone-cta">Glissez vos fichiers ici ou cliquez</div>
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
    <div className="rcp-integrity">
      ⚠ {side} : le total imprimé (<span className="num">{eur(agg.statedTotal)}</span>) ne colle pas
      à la somme des lignes lues (<span className="num">{eur(agg.sumLines)}</span>). Une ligne a
      peut-être été mal lue — vérifiez le détail avant de conclure.
    </div>
  );
}

function EcartTable({ title, rows, cols, empty }) {
  return (
    <section className="rcp-table-block">
      <h3 className="rcp-table-title">
        {title} <span className="rcp-count">{rows.length}</span>
      </h3>
      {rows.length === 0 ? (
        <p className="rcp-empty">{empty}</p>
      ) : (
        <div className="rcp-table-wrap">
          <table className="rcp-table">
            <thead>
              <tr>
                {cols.map((c, i) => (
                  <th key={i} className={c[2].includes("num") ? "ta-r" : "ta-l"}>
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
      )}
    </section>
  );
}

function DetailTable({ title, agg }) {
  const rows = [...agg.map.values()];
  return (
    <section className="rcp-table-block">
      <h3 className="rcp-table-title">{title}</h3>
      <div className="rcp-table-wrap">
        <table className="rcp-table small">
          <thead>
            <tr>
              <th className="ta-l">Produit</th>
              <th className="ta-l">Code</th>
              <th className="ta-r">Qté</th>
              <th className="ta-r">PU HT</th>
              <th className="ta-r">Montant</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="ta-l">{r.designation}</td>
                <td className="ta-l mono">{r.code || "—"}</td>
                <td className="ta-r num">{qty(r.qte)}</td>
                <td className="ta-r num">{r.puKnown ? eur(r.pu) : "—"}</td>
                <td className="ta-r num">{r.puKnown ? eur(r.montant) : "—"}</td>
              </tr>
            ))}
            <tr className="rcp-total-row">
              <td className="ta-l strong" colSpan={4}>
                Total
              </td>
              <td className="ta-r num strong">{eur(agg.sumLines)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
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

.rcp-foot{max-width:880px; margin:28px auto 0; font-size:12px; color:var(--muted); text-align:center;}
`;
