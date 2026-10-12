/* =====================================================================
   APP DE SEGURIDAD · CASETA DEL FRACCIONAMIENTO
   Firebase v10 (SDK modular vía CDN): Auth + Firestore + Storage
   Comparte base de datos con el Panel Admin y el Portal de Residentes.
   ===================================================================== */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAnalytics, isSupported } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-analytics.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInAnonymously,
  signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore,
  collection,
  doc,
  getDoc,
  getDocFromServer,
  getDocs,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  addDoc,
  updateDoc,
  serverTimestamp,
  Timestamp,
  increment
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getStorage,
  ref as storageRef,
  uploadBytesResumable,
  getDownloadURL
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";

/* ---------------------------------------------------------------------
   1. FIREBASE
   --------------------------------------------------------------------- */
const firebaseConfig = { apiKey: "AIzaSyCNWsowcsixY7I4JDuOzoQfu3Jdx9UFGNQ", authDomain: "doc-con-ia.firebaseapp.com", projectId: "doc-con-ia", storageBucket: "doc-con-ia.firebasestorage.app", messagingSenderId: "952895131866", appId: "1:952895131866:web:edd126a29c7f11e41295e3", measurementId: "G-HWWWE5FW7N" };

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const storage = getStorage(app); // usa el bucket "doc-con-ia.firebasestorage.app"
isSupported().then((ok) => ok && getAnalytics(app)).catch(() => {});

/* ---------------------------------------------------------------------
   2. CONFIGURACIÓN
   --------------------------------------------------------------------- */
const COL = {
  pases: "pases_qr",                     // pases que generan los residentes
  accesos: "accesos_registrados",        // entradas registradas por la caseta
  incidencias: "incidencias_seguridad",  // reportes de rondín
  casas: "casas"                         // padrón (para validar QR de residente)
};

const CONFIG = {
  caseta: "Caseta principal",
  requiereLogin: true,        // false = sesión anónima (solo pruebas)
  toleranciaMin: 15,          // minutos de tolerancia antes del inicio de un pase
  maxLadoFoto: 1600,          // px del lado mayor tras comprimir
  calidadFoto: 0.8,
  prefijoQR: "FRACC",
  campoFecha: "fecha",        // mismo campo de fecha que leen admin y residentes
  puntosRondin: [
    "Caseta / acceso principal",
    "Acceso peatonal",
    "Barda perimetral norte",
    "Barda perimetral sur",
    "Casa club",
    "Cancha de pasto sintético",
    "Parque de fiestas",
    "Área verde / palapa",
    "Cuarto de máquinas / cisterna",
    "Estacionamiento de visitas",
    "Otro punto"
  ]
};

const GRUPOS_FOTO = {
  acceso: ["Placas", "Identificación", "Otra"],
  incidencia: ["Evidencia 1", "Evidencia 2", "Evidencia 3"]
};

/* ---------------------------------------------------------------------
   3. ESTADO
   --------------------------------------------------------------------- */
const state = {
  user: null,
  guardia: "",
  validacion: null,
  fotos: { acceso: [null, null, null], incidencia: [null, null, null] },
  accesos: [],
  bitacora: [],
  cargado: { accesos: false, bitacora: false },
  filtroAccesos: "",
  unsubs: [],
  diaListeners: "",
  scanner: { stream: null, activo: false, detector: null, canvas: null }
};

/* ---------------------------------------------------------------------
   4. UTILIDADES
   --------------------------------------------------------------------- */
const $ = (s, c = document) => c.querySelector(s);
const $$ = (s, c = document) => [...c.querySelectorAll(s)];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const icon = (n) => `<svg class="icon" aria-hidden="true"><use href="#i-${n}"/></svg>`;
const pad = (n) => String(n).padStart(2, "0");
const pick = (o, keys, def = "") => {
  for (const k of keys) {
    const v = o?.[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return def;
};
const normalizar = (s) => String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

function toDate(v) {
  if (!v) return null;
  if (typeof v.toDate === "function") return v.toDate();
  if (v instanceof Date) return isNaN(v) ? null : v;
  if (typeof v === "object" && "seconds" in v) return new Date(v.seconds * 1000);
  const d = new Date(v);
  return isNaN(d) ? null : d;
}
const fmt = (d, o) => (d ? new Intl.DateTimeFormat("es-MX", o).format(d) : "—");
const hora = (d) => fmt(d, { hour: "2-digit", minute: "2-digit" });
const fechaHora = (d) => fmt(d, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const claveDia = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const inicioDelDia = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

function duracion(ms) {
  const min = Math.round(Math.abs(ms) / 60000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h ${min % 60 ? `${min % 60} min` : ""}`.trim();
  return `${Math.floor(h / 24)} días`;
}

const mapDocs = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) }));
const badge = (t, tipo) => `<span class="badge badge--${tipo}">${esc(t)}</span>`;

function toast(msg, tipo = "info", ms = 4000) {
  const el = document.createElement("div");
  el.className = `toast toast--${tipo}`;
  el.setAttribute("role", tipo === "error" ? "alert" : "status");
  el.innerHTML = `${icon(tipo === "success" ? "check" : tipo === "info" ? "shield" : "alert")}<span>${esc(msg)}</span>`;
  $("#toasts").append(el);
  requestAnimationFrame(() => el.classList.add("is-visible"));
  setTimeout(() => {
    el.classList.remove("is-visible");
    setTimeout(() => el.remove(), 250);
  }, ms);
}

function errorAmigable(err) {
  const c = err?.code || "";
  if (c === "permission-denied" || c === "storage/unauthorized") return "Sin permisos. Revisa las reglas de Firebase con la administración.";
  if (c === "unavailable" || c === "storage/retry-limit-exceeded") return "Sin conexión con el servidor. Intenta de nuevo.";
  if (c === "storage/canceled") return "La subida de la foto se canceló.";
  if (c === "storage/quota-exceeded") return "Se agotó el espacio de almacenamiento de fotos.";
  return err?.message || "Ocurrió un error inesperado.";
}

/** Retroalimentación para el guardia: vibración + tono corto. */
function aviso(tipo) {
  try {
    navigator.vibrate?.(tipo === "ok" ? 120 : [250, 120, 250]);
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = tipo === "ok" ? 880 : 220;
    gain.gain.value = 0.15;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + (tipo === "ok" ? 0.15 : 0.45));
    osc.onended = () => ctx.close();
  } catch { /* sin audio disponible */ }
}

async function conCarga(btn, fn) {
  btn.disabled = true;
  btn.classList.add("is-loading");
  try {
    return await fn();
  } finally {
    btn.disabled = false;
    btn.classList.remove("is-loading");
  }
}

/** Guarda en Firestore; si no hay internet, deja la escritura en cola y no bloquea la pantalla. */
async function guardar(promesa) {
  if (navigator.onLine) return promesa;
  promesa.catch((e) => toast(`No se sincronizó un registro: ${errorAmigable(e)}`, "error", 7000));
  toast("Sin internet: el registro se guardó en el dispositivo y se enviará al reconectar.", "warning", 6000);
  return null;
}

/* ---------------------------------------------------------------------
   5. MODAL, PROGRESO Y NAVEGACIÓN
   --------------------------------------------------------------------- */
let resolverModal = null;

function abrirModal({ titulo, html, ok = "Aceptar", tipo = "primary", soloLectura = false }) {
  $("#modal-titulo").textContent = titulo;
  $("#modal-body").innerHTML = html;
  const b = $("#modal-ok");
  b.textContent = ok;
  b.className = `btn btn--${tipo} btn--lg`;
  b.hidden = soloLectura;
  $("#modal-cancelar").textContent = soloLectura ? "Cerrar" : "Cancelar";
  $("#modal").hidden = false;
  document.body.classList.add("no-scroll");
  setTimeout(() => ($("#modal-body [name]") || $("#modal-cancelar")).focus(), 50);
  return new Promise((r) => (resolverModal = r));
}
function cerrarModal(res = { ok: false, datos: {} }) {
  $("#modal").hidden = true;
  document.body.classList.remove("no-scroll");
  resolverModal?.(res);
  resolverModal = null;
}
$("#modal-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const datos = {};
  $$("#modal-body [name]").forEach((el) => (datos[el.name] = el.type === "checkbox" ? el.checked : el.value.trim()));
  cerrarModal({ ok: true, datos });
});
$$("[data-cerrar-modal]").forEach((el) => el.addEventListener("click", () => cerrarModal()));

function verFoto(url, titulo = "Evidencia") {
  abrirModal({ titulo, html: `<img src="${esc(url)}" alt="${esc(titulo)}">`, soloLectura: true });
}

const progreso = {
  mostrar(titulo) {
    $("#progreso-titulo").textContent = titulo;
    this.set(0, "Preparando…");
    $("#progreso").hidden = false;
  },
  set(pct, detalle) {
    $("#progreso-barra").style.width = `${Math.round(pct)}%`;
    $("#progreso-detalle").textContent = detalle ?? `${Math.round(pct)}%`;
  },
  ocultar() {
    $("#progreso").hidden = true;
  }
};

const VISTAS = ["validar", "accesos", "rondin"];
function irA(vista) {
  if (!VISTAS.includes(vista)) vista = "validar";
  $$(".view").forEach((v) => (v.hidden = v.id !== `view-${vista}`));
  $$(".tab").forEach((t) => {
    const activa = t.dataset.view === vista;
    t.classList.toggle("is-active", activa);
    activa ? t.setAttribute("aria-current", "page") : t.removeAttribute("aria-current");
  });
  history.replaceState(null, "", `#${vista}`);
  window.scrollTo({ top: 0 });
  if (vista === "validar" && !state.validacion) setTimeout(() => $("#codigo").focus(), 60);
}
$$(".tab").forEach((t) => t.addEventListener("click", () => irA(t.dataset.view)));

/* ---------------------------------------------------------------------
   6. FOTOGRAFÍAS: captura, compresión con sello y subida a STORAGE
   --------------------------------------------------------------------- */
function renderSlots(grupo) {
  const cont = $(`.slots[data-grupo="${grupo}"]`);
  cont.innerHTML = GRUPOS_FOTO[grupo]
    .map((label, i) => {
      const f = state.fotos[grupo][i];
      return `<div class="slot ${f ? "has-foto" : ""}">
        <label class="slot__pick">
          <input type="file" accept="image/*" capture="environment" data-grupo="${grupo}" data-i="${i}" aria-label="Foto: ${esc(label)}">
          ${f ? `<img class="slot__img" src="${f.preview}" alt="">` : `${icon("camera")}<span>${esc(label)}</span>`}
          ${f ? `<span class="slot__tag">${esc(label)}</span>` : ""}
        </label>
        ${f ? `<button type="button" class="slot__del" data-quitar="${grupo}" data-i="${i}" aria-label="Quitar foto ${esc(label)}">${icon("x")}</button>` : ""}
      </div>`;
    })
    .join("");
}

function limpiarFotos(grupo) {
  state.fotos[grupo].forEach((f) => f && URL.revokeObjectURL(f.preview));
  state.fotos[grupo] = [null, null, null];
  renderSlots(grupo);
}

/** Reduce la foto y le estampa fecha/hora, caseta y guardia (evidencia). */
async function comprimirConSello(file, etiqueta) {
  let img;
  try {
    img = await createImageBitmap(file);
  } catch {
    img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = URL.createObjectURL(file);
    });
  }
  const r = Math.min(1, CONFIG.maxLadoFoto / Math.max(img.width, img.height));
  const w = Math.round(img.width * r);
  const h = Math.round(img.height * r);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0, w, h);

  // Sello de agua inferior
  const fs = Math.max(14, Math.round(w / 40));
  const texto = `${fmt(new Date(), { dateStyle: "short", timeStyle: "medium" })} · ${CONFIG.caseta} · ${state.guardia} · ${etiqueta}`;
  ctx.fillStyle = "rgba(0,0,0,.6)";
  ctx.fillRect(0, h - fs * 2, w, fs * 2);
  ctx.fillStyle = "#fff";
  ctx.font = `700 ${fs}px Inter, Arial, sans-serif`;
  ctx.textBaseline = "middle";
  ctx.fillText(texto, fs * 0.6, h - fs, w - fs * 1.2);

  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("No se pudo procesar la foto."))), "image/jpeg", CONFIG.calidadFoto));
}

document.addEventListener("change", async (e) => {
  const input = e.target.closest('.slot input[type="file"]');
  if (!input) return;
  const file = input.files?.[0];
  if (!file) return;
  const { grupo, i } = input.dataset;
  if (!file.type.startsWith("image/")) return toast("El archivo debe ser una imagen.", "warning");
  try {
    const blob = await comprimirConSello(file, GRUPOS_FOTO[grupo][i]);
    const previa = state.fotos[grupo][i];
    if (previa) URL.revokeObjectURL(previa.preview);
    state.fotos[grupo][i] = { blob, preview: URL.createObjectURL(blob), etiqueta: GRUPOS_FOTO[grupo][i] };
    renderSlots(grupo);
  } catch (err) {
    console.error(err);
    toast("No se pudo leer la foto. Intenta tomarla de nuevo.", "error");
  }
});

document.addEventListener("click", (e) => {
  const q = e.target.closest("[data-quitar]");
  if (!q) return;
  e.preventDefault();
  const { quitar: grupo, i } = q.dataset;
  const f = state.fotos[grupo][i];
  if (f) URL.revokeObjectURL(f.preview);
  state.fotos[grupo][i] = null;
  renderSlots(grupo);
});

/**
 * ======== FIREBASE STORAGE: SUBIDA DE FOTOS ========
 * Sube cada foto del grupo a Storage en la carpeta indicada y devuelve
 * [{ tipo, url, path }]. La URL pública de descarga se obtiene con
 * getDownloadURL() y es la que se guarda en Firestore para que el
 * Panel Admin pueda mostrar la imagen.
 */
async function subirFotos(grupo, carpeta, meta = {}) {
  const pendientes = state.fotos[grupo].filter(Boolean);
  const resultado = [];

  for (let n = 0; n < pendientes.length; n++) {
    const foto = pendientes[n];
    const nombre = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${normalizar(foto.etiqueta).replace(/[^a-z0-9]+/g, "-")}.jpg`;
    const ruta = `${carpeta}/${nombre}`;

    // 1) Referencia al archivo destino dentro del bucket de Storage
    const destino = storageRef(storage, ruta);

    // 2) Subida reanudable (permite mostrar el porcentaje de avance)
    const tarea = uploadBytesResumable(destino, foto.blob, {
      contentType: "image/jpeg",
      customMetadata: {
        guardia: state.guardia,
        caseta: CONFIG.caseta,
        etiqueta: foto.etiqueta,
        uid: state.user?.uid || "",
        ...meta
      }
    });

    await new Promise((resolve, reject) => {
      tarea.on(
        "state_changed",
        (snap) => {
          const parcial = snap.totalBytes ? snap.bytesTransferred / snap.totalBytes : 0;
          progreso.set(((n + parcial) / pendientes.length) * 100, `Foto ${n + 1} de ${pendientes.length} · ${Math.round(parcial * 100)}%`);
        },
        reject,
        resolve
      );
    });

    // 3) URL de descarga que se guardará en el documento de Firestore
    const url = await getDownloadURL(tarea.snapshot.ref);
    resultado.push({ tipo: foto.etiqueta, url, path: ruta });
  }
  return resultado;
}

/* ---------------------------------------------------------------------
   7. VALIDACIÓN DE PASES QR
   --------------------------------------------------------------------- */
/**
 * Interpreta lo que escribió o escaneó el guardia:
 *  - "FRACC|PASE|<id>|<codigo>"  → QR generado por el portal de residentes
 *  - "FRACC|RESIDENTE|<casaId>|<uid>" → QR identificador del residente (titular o inquilino)
 *  - "A1B2C3D4E5F6"             → código corto impreso en la imagen del pase
 *  - cualquier otro texto       → se trata como ID del documento del pase
 */
function interpretar(raw) {
  const t = raw.trim();
  const partes = t.split("|").map((p) => p.trim());
  if (partes[0]?.toUpperCase() === CONFIG.prefijoQR) {
    const tipo = partes[1]?.toUpperCase();
    if (tipo === "PASE") return { tipo: "pase", id: partes[2], codigo: partes[3] };
    if (tipo === "RESIDENTE") return { tipo: "residente", casaId: partes[2], uid: partes[3] || "" };
  }
  if (/^[0-9A-F]{12}$/i.test(t)) return { tipo: "codigo", codigo: t.toUpperCase() };
  return { tipo: "pase", id: t };
}

/** Lee un documento priorizando el servidor (dato más fresco) y cae al caché si no hay red. */
async function leerDoc(ref) {
  try {
    return await getDocFromServer(ref);
  } catch (err) {
    if (err?.code === "unavailable" || !navigator.onLine) return getDoc(ref);
    throw err;
  }
}

async function buscarPase(lectura) {
  // ======== FIRESTORE: buscar el pase por ID de documento ========
  if (lectura.id && !lectura.id.includes("/")) {
    const snap = await leerDoc(doc(db, COL.pases, lectura.id));
    if (snap.exists()) return { id: snap.id, ...snap.data() };
  }
  // ======== FIRESTORE: buscar por código corto (campo "codigo") ========
  const codigo = (lectura.codigo || lectura.id || "").toUpperCase();
  if (/^[0-9A-F]{6,}$/.test(codigo)) {
    const snap = await getDocs(query(collection(db, COL.pases), where("codigo", "==", codigo), limit(1)));
    if (!snap.empty) return { id: snap.docs[0].id, ...snap.docs[0].data() };
  }
  return null;
}

function evaluarPase(p, codigoLeido) {
  const ahora = Date.now();
  const desde = toDate(p.validoDesde);
  const hasta = toDate(p.validoHasta);
  const est = normalizar(pick(p, ["estatus", "estado"], "activo"));

  if (codigoLeido && p.codigo && codigoLeido.toUpperCase() !== String(p.codigo).toUpperCase())
    return { estado: "invalido", titulo: "QR alterado", motivo: "El código de seguridad no coincide con el pase registrado." };
  if (/cancel/.test(est))
    return { estado: "invalido", titulo: "Pase cancelado", motivo: "El residente canceló este pase." };
  if (p.usoUnico && Number(p.usos) > 0)
    return { estado: "invalido", titulo: "Pase ya utilizado", motivo: "Este pase era de un solo uso." };
  if (hasta && hasta.getTime() < ahora)
    return { estado: "invalido", titulo: "Pase vencido", motivo: `Venció hace ${duracion(ahora - hasta.getTime())} (${fechaHora(hasta)}).` };
  if (desde && desde.getTime() - CONFIG.toleranciaMin * 60000 > ahora)
    return { estado: "alerta", titulo: "Aún no es válido", motivo: `Inicia el ${fechaHora(desde)} (en ${duracion(desde.getTime() - ahora)}).` };
  return {
    estado: "valido",
    titulo: "Acceso válido",
    motivo: hasta ? `Vigente hasta ${fechaHora(hasta)} · quedan ${duracion(hasta.getTime() - ahora)}` : "Pase vigente"
  };
}

async function validar(raw) {
  const texto = raw.trim();
  if (!texto) {
    $("#codigo").focus();
    return;
  }
  const lectura = interpretar(texto);

  await conCarga($("#btn-validar"), async () => {
    try {
      if (lectura.tipo === "residente") return await validarResidente(lectura);

      const pase = await buscarPase(lectura);
      if (!pase) {
        mostrarResultado({
          modo: "pase",
          estado: "invalido",
          titulo: "Pase no encontrado",
          motivo: "No existe ningún pase con ese código. Verifica o registra como visita sin QR.",
          casa: "—",
          visitante: "—",
          filas: [["Código leído", texto.length > 40 ? `${texto.slice(0, 40)}…` : texto]]
        });
        return;
      }

      const r = evaluarPase(pase, lectura.codigo);
      mostrarResultado({
        modo: "pase",
        ...r,
        pase,
        casa: pase.casa || "—",
        visitante: pase.visitante || "—",
        filas: [
          ["Tipo de visita", pase.tipoVisita || "Visita"],
          ["Autoriza", pase.residente || "—"],
          ["Válido desde", fechaHora(toDate(pase.validoDesde))],
          ["Válido hasta", fechaHora(toDate(pase.validoHasta))],
          ["Placas registradas", pase.placas || "—"],
          ["Entradas previas", String(pase.usos || 0)],
          ["Código", pase.codigo || pase.id]
        ]
      });
    } catch (err) {
      console.error(err);
      toast(`No se pudo validar: ${errorAmigable(err)}`, "error", 6000);
    }
  });
}

const faseTexto = (f) => (f === undefined || f === null || f === "" ? "" : /^\d/.test(String(f)) ? `Fase ${f}` : String(f));
const etiquetaCasa = (c) => c.etiqueta || [`Casa ${pick(c, ["numero", "numeroCasa"], "")}`, c.privada, faseTexto(c.fase)].filter(Boolean).join(" · ");

async function validarResidente({ casaId, uid }) {
  // ======== FIRESTORE: leer la casa por su ID (viene en el QR del residente) ========
  let casa = null;
  if (casaId && !casaId.includes("/")) {
    const snap = await leerDoc(doc(db, COL.casas, casaId));
    if (snap.exists()) casa = { id: snap.id, ...snap.data() };
  }
  // Compatibilidad con QR antiguos que solo traían el número ("Casa 12")
  if (!casa && casaId) {
    const num = (String(casaId).match(/\d+[A-Za-z]?/) || [casaId])[0];
    const variantes = [...new Set([casaId, num, `Casa ${num}`, ...(/^\d+$/.test(num) ? [Number(num)] : [])])];
    const snap = await getDocs(query(collection(db, COL.casas), where("numero", "in", variantes), limit(1)));
    if (!snap.empty) casa = { id: snap.docs[0].id, ...snap.docs[0].data() };
  }

  if (!casa) {
    mostrarResultado({
      modo: "residente",
      estado: "invalido",
      titulo: "Casa no registrada",
      motivo: "El QR no corresponde a ninguna casa del padrón.",
      casa: "—",
      visitante: "—",
      filas: [["Dato leído", casaId || "—"]]
    });
    return;
  }

  // La persona debe seguir apareciendo como titular o inquilino de esa casa
  const titulares = Array.isArray(casa.titulares) ? casa.titulares.map((p) => ({ ...p, rol: "Titular" })) : [];
  const inquilinos = casa.tieneInquilinos && Array.isArray(casa.inquilinos) ? casa.inquilinos.map((p) => ({ ...p, rol: "Inquilino" })) : [];
  const persona = uid ? [...titulares, ...inquilinos].find((p) => p.uid === uid) : null;
  const etiqueta = etiquetaCasa(casa);
  const filasBase = [
    ["Privada", casa.privada || "—"],
    ["Fase", faseTexto(casa.fase) || "—"]
  ];

  if (uid && !persona) {
    mostrarResultado({
      modo: "residente",
      estado: "invalido",
      titulo: "Acceso revocado",
      motivo: "Esta persona ya no está registrada en la casa. Pide identificación y confirma con la administración.",
      casa: etiqueta,
      visitante: "Residente no vigente",
      filas: filasBase
    });
    return;
  }

  let estado = "valido";
  let motivo = "QR identificador de residente.";
  if (persona?.rol === "Inquilino" && persona.contratoHasta) {
    const fin = new Date(`${String(persona.contratoHasta).slice(0, 10)}T23:59:59`);
    if (!isNaN(fin) && fin < new Date()) {
      estado = "alerta";
      motivo = "El contrato de este inquilino ya venció. Confirma con el titular antes de permitir el paso.";
    }
  }

  mostrarResultado({
    modo: "residente",
    estado,
    titulo: estado === "valido" ? "Residente identificado" : "Contrato vencido",
    motivo,
    casa: etiqueta,
    visitante: persona?.nombre || pick(casa, ["propietario"], "Residente"),
    filas: [
      ["Perfil", persona?.rol || "Residente"],
      ...filasBase,
      ...(persona?.rol === "Inquilino" && persona.contratoHasta ? [["Contrato hasta", String(persona.contratoHasta).slice(0, 10)]] : [])
    ]
  });
}

function mostrarResultado(v) {
  state.validacion = v;
  const iconos = { valido: "check", invalido: "x", alerta: "alert" };
  $("#resultado").innerHTML = `
    <article class="result result--${v.estado}">
      <div class="result__banner">
        ${icon(iconos[v.estado])}
        <div>
          <p class="result__state">${esc(v.titulo)}</p>
          <p class="result__reason">${esc(v.motivo)}</p>
        </div>
      </div>
      <div class="result__casa">
        <small>Destino</small>
        <strong>${esc(v.casa)}</strong>
        <span class="result__visit">${esc(v.visitante)}</span>
      </div>
      <dl class="result__grid">
        ${(v.filas || []).map(([k, val]) => `<div><dt>${esc(k)}</dt><dd>${esc(val)}</dd></div>`).join("")}
      </dl>
    </article>`;

  aviso(v.estado === "valido" ? "ok" : "error");

  // Preparar el formulario de registro según el resultado
  const form = $("#form-acceso");
  form.hidden = false;
  form.reset();
  form.placas.value = v.pase?.placas || "";
  form.acompanantes.value = "0";
  $("#acceso-error").textContent = "";
  $("#row-confirmo").hidden = !(v.modo === "manual" || v.estado === "alerta");

  const btn = $("#btn-registrar");
  if (v.estado === "invalido") {
    btn.className = "btn btn--danger-outline btn--xl";
    $("#btn-registrar-txt").textContent = "Registrar acceso denegado";
  } else {
    btn.className = "btn btn--success btn--xl";
    $("#btn-registrar-txt").textContent = v.estado === "alerta" ? "Autorizar y registrar entrada" : "Registrar entrada";
  }

  $("#resultado").scrollIntoView({ behavior: "smooth", block: "start" });
}

function nuevaBusqueda() {
  state.validacion = null;
  $("#form-acceso").hidden = true;
  $("#form-acceso").reset();
  limpiarFotos("acceso");
  $("#resultado").innerHTML = `<div class="placeholder">${icon("qr")}<p>Esperando código…</p><small>El resultado de la validación aparecerá aquí.</small></div>`;
  $("#codigo").value = "";
  $("#codigo").focus();
}

$("#form-buscar").addEventListener("submit", (e) => {
  e.preventDefault();
  validar($("#codigo").value);
});
$("#btn-nueva").addEventListener("click", nuevaBusqueda);

$("#btn-manual").addEventListener("click", async () => {
  const r = await abrirModal({
    titulo: "Visita sin código QR",
    html: `
      <label class="field"><span class="field__label">Casa que visita *</span>
        <input name="casa" required maxlength="30" placeholder="Ej. Casa 12" autocomplete="off"></label>
      <label class="field"><span class="field__label">Nombre de la visita *</span>
        <input name="visitante" required minlength="3" maxlength="80" autocomplete="off"></label>
      <label class="field"><span class="field__label">Motivo</span>
        <select name="motivo">
          <option>Visita familiar</option><option>Servicio / técnico</option><option>Paquetería / entrega</option>
          <option>Transporte (taxi / app)</option><option>Proveedor del fraccionamiento</option><option>Otro</option>
        </select></label>`,
    ok: "Continuar"
  });
  if (!r.ok) return;
  const casa = /^\d+[A-Za-z]?$/.test(r.datos.casa) ? `Casa ${r.datos.casa}` : r.datos.casa;
  mostrarResultado({
    modo: "manual",
    estado: "alerta",
    titulo: "Visita sin pase",
    motivo: "Confirma con el residente por teléfono o interfón antes de dar acceso.",
    casa,
    visitante: r.datos.visitante,
    motivoVisita: r.datos.motivo,
    filas: [["Motivo", r.datos.motivo], ["Registro", "Manual en caseta"]]
  });
});

/* ---------------------------------------------------------------------
   8. REGISTRO DE ACCESO (Storage + Firestore)
   --------------------------------------------------------------------- */
$("#form-acceso").addEventListener("submit", async (e) => {
  e.preventDefault();
  const v = state.validacion;
  if (!v) return;
  const form = e.currentTarget;
  const err = $("#acceso-error");
  err.textContent = "";

  const permitido = v.estado !== "invalido";
  const requiereConfirmacion = !$("#row-confirmo").hidden;
  if (permitido && requiereConfirmacion && !form.confirmo.checked) {
    err.textContent = "Marca la casilla para confirmar que el residente autorizó la entrada.";
    return;
  }

  const hayFotos = state.fotos.acceso.some(Boolean);
  if (hayFotos && !navigator.onLine) {
    err.textContent = "Sin internet no es posible subir fotografías. Quítalas o espera a tener conexión.";
    return;
  }

  await conCarga($("#btn-registrar"), async () => {
    try {
      // ---------- 1) FIREBASE STORAGE: subir evidencia fotográfica ----------
      let fotos = [];
      if (hayFotos) {
        progreso.mostrar("Subiendo evidencia del acceso…");
        fotos = await subirFotos("acceso", `accesos/${claveDia(new Date())}`, { casa: String(v.casa) });
      }

      // ---------- 2) FIRESTORE: crear el documento en "accesos_registrados" ----------
      const registro = {
        tipoAcceso: "entrada",
        valido: permitido,
        autorizado: permitido,
        resultado: v.titulo,
        motivoResultado: v.motivo,
        metodo: v.modo === "manual" ? "manual" : v.modo === "residente" ? "qr_residente" : "qr_pase",
        paseId: v.pase?.id || null,
        codigoPase: v.pase?.codigo || null,
        casa: v.casa,
        visitante: v.visitante,
        residente: v.pase?.residente || null,
        tipoVisita: v.pase?.tipoVisita || v.motivoVisita || (v.modo === "residente" ? "Residente" : "Visita"),
        placas: form.placas.value.trim().toUpperCase(),
        acompanantes: Number(form.acompanantes.value) || 0,
        observaciones: form.observaciones.value.trim(),
        confirmadoConResidente: requiereConfirmacion ? form.confirmo.checked : null,
        fotos,                                   // [{ tipo, url, path }]
        fotoUrl: fotos[0]?.url || null,          // primera foto (la usa el Panel Admin)
        guardia: state.guardia,
        uidGuardia: state.user?.uid || null,
        caseta: CONFIG.caseta,
        horaEntrada: permitido ? serverTimestamp() : null,
        horaSalida: null,
        [CONFIG.campoFecha]: serverTimestamp()
      };
      progreso.set(100, "Guardando registro…");
      await guardar(addDoc(collection(db, COL.accesos), registro));

      // ---------- 3) FIRESTORE: actualizar contador de usos del pase ----------
      if (permitido && v.pase?.id) {
        await guardar(
          updateDoc(doc(db, COL.pases, v.pase.id), {
            usos: increment(1),
            ultimoAcceso: serverTimestamp(),
            ultimoGuardia: state.guardia
          })
        );
      }

      progreso.ocultar();
      toast(permitido ? `Entrada registrada: ${v.visitante} → ${v.casa}` : "Intento de acceso denegado registrado.", permitido ? "success" : "warning");
      nuevaBusqueda();
    } catch (ex) {
      progreso.ocultar();
      console.error(ex);
      err.textContent = `No se pudo registrar: ${errorAmigable(ex)}`;
    }
  });
});

/* ---------------------------------------------------------------------
   9. ESCÁNER CON CÁMARA (BarcodeDetector nativo, jsQR como respaldo)
   --------------------------------------------------------------------- */
function cargarJsQR() {
  if (window.jsQR) return Promise.resolve();
  return new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js";
    s.onload = res;
    s.onerror = () => rej(new Error("No se pudo cargar el lector de QR."));
    document.head.append(s);
  });
}

async function abrirEscaner() {
  if (!navigator.mediaDevices?.getUserMedia) {
    toast("Este dispositivo no permite usar la cámara aquí. Usa el lector o teclea el código.", "warning", 6000);
    return;
  }
  const sc = state.scanner;
  try {
    sc.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
  } catch (err) {
    toast(err?.name === "NotAllowedError" ? "Permiso de cámara denegado. Actívalo en el navegador." : "No se pudo abrir la cámara.", "error", 6000);
    return;
  }

  const video = $("#scanner-video");
  video.srcObject = sc.stream;
  $("#scanner").hidden = false;
  document.body.classList.add("no-scroll");
  await video.play().catch(() => {});

  sc.detector = null;
  if ("BarcodeDetector" in window) {
    try {
      const formatos = await window.BarcodeDetector.getSupportedFormats();
      if (formatos.includes("qr_code")) sc.detector = new window.BarcodeDetector({ formats: ["qr_code"] });
    } catch { /* usar respaldo */ }
  }
  if (!sc.detector) {
    try {
      await cargarJsQR();
      sc.canvas = sc.canvas || document.createElement("canvas");
    } catch (err) {
      cerrarEscaner();
      toast(err.message, "error");
      return;
    }
  }

  sc.activo = true;
  let ultimo = 0;
  const ciclo = async (t) => {
    if (!sc.activo) return;
    if (t - ultimo > 180 && video.readyState >= 2) {
      ultimo = t;
      const texto = await leerFotograma(video);
      if (texto) {
        cerrarEscaner();
        $("#codigo").value = texto;
        validar(texto);
        return;
      }
    }
    requestAnimationFrame(ciclo);
  };
  requestAnimationFrame(ciclo);
}

async function leerFotograma(video) {
  const sc = state.scanner;
  try {
    if (sc.detector) {
      const codigos = await sc.detector.detect(video);
      return codigos[0]?.rawValue || null;
    }
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return null;
    const escala = Math.min(1, 720 / Math.max(w, h));
    sc.canvas.width = Math.round(w * escala);
    sc.canvas.height = Math.round(h * escala);
    const ctx = sc.canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, sc.canvas.width, sc.canvas.height);
    const data = ctx.getImageData(0, 0, sc.canvas.width, sc.canvas.height);
    return window.jsQR(data.data, data.width, data.height, { inversionAttempts: "dontInvert" })?.data || null;
  } catch {
    return null;
  }
}

function cerrarEscaner() {
  const sc = state.scanner;
  sc.activo = false;
  sc.stream?.getTracks().forEach((t) => t.stop());
  sc.stream = null;
  $("#scanner-video").srcObject = null;
  $("#scanner").hidden = true;
  document.body.classList.remove("no-scroll");
}

$("#btn-camara").addEventListener("click", abrirEscaner);
$("#scanner-cerrar").addEventListener("click", cerrarEscaner);

/* ---------------------------------------------------------------------
   10. ACCESOS DE HOY + REGISTRO DE SALIDA
   --------------------------------------------------------------------- */
function renderAccesos() {
  const lista = state.accesos;
  const dentro = lista.filter((a) => a.valido !== false && !a.horaSalida);
  $("#cnt-total").textContent = lista.length;
  $("#cnt-dentro").textContent = dentro.length;
  $("#cnt-denegados").textContent = lista.filter((a) => a.valido === false).length;
  const b = $("#badge-dentro");
  b.hidden = !dentro.length;
  b.textContent = dentro.length > 99 ? "99+" : dentro.length;

  const cont = $("#lista-accesos");
  if (!state.cargado.accesos) return;
  const q = normalizar(state.filtroAccesos);
  const filtrados = lista.filter((a) => !q || normalizar(`${a.visitante} ${a.casa} ${a.placas} ${a.guardia}`).includes(q));

  if (!filtrados.length) {
    cont.innerHTML = `<li class="empty">${q ? "Sin resultados." : "Aún no hay accesos registrados hoy."}</li>`;
    return;
  }

  cont.innerHTML = filtrados
    .map((a) => {
      const negado = a.valido === false;
      const salio = !!a.horaSalida;
      const clase = negado ? "bad" : salio ? "out" : "ok";
      const estado = negado ? badge("Denegado", "bad") : salio ? badge(`Salió ${hora(toDate(a.horaSalida))}`, "neutral") : badge("Dentro", "ok");
      const foto = a.fotoUrl || a.fotos?.[0]?.url;
      return `<li class="row row--${clase}">
        ${
          foto
            ? `<button type="button" class="row__thumb" data-foto="${esc(foto)}" data-titulo="${esc(a.visitante)}" aria-label="Ver foto"><img src="${esc(foto)}" alt="" loading="lazy"></button>`
            : `<span class="row__thumb">${icon(a.metodo === "manual" ? "user" : "qr")}</span>`
        }
        <div class="row__body">
          <div class="row__top"><span class="row__title">${esc(a.visitante || "Visita")}</span>${estado}</div>
          <div class="row__meta">
            <span>${icon("home")}${esc(a.casa || "—")}</span>
            <span>${icon("clock")}${esc(hora(toDate(a.horaEntrada) || toDate(a.fecha)))}</span>
            ${a.placas ? `<span>${icon("car")}${esc(a.placas)}</span>` : ""}
            <span>${icon("shield")}${esc(a.guardia || "—")}</span>
          </div>
          ${a.observaciones ? `<p class="row__text">${esc(a.observaciones)}</p>` : ""}
          ${
            !negado && !salio
              ? `<div class="row__actions"><button type="button" class="btn btn--secondary btn--sm" data-salida="${esc(a.id)}">${icon("exit")}<span>Registrar salida</span></button></div>`
              : ""
          }
        </div>
      </li>`;
    })
    .join("");
}

async function registrarSalida(id, btn) {
  const a = state.accesos.find((x) => x.id === id);
  if (!a) return;
  const r = await abrirModal({
    titulo: "Registrar salida",
    html: `<p style="font-size:1.15rem;font-weight:700">${esc(a.visitante)} sale de ${esc(a.casa)}.</p>
           <label class="field"><span class="field__label">Observaciones de salida</span>
           <input name="obs" maxlength="200" placeholder="Opcional"></label>`,
    ok: "Confirmar salida",
    tipo: "success"
  });
  if (!r.ok) return;
  await conCarga(btn, async () => {
    try {
      // ======== FIRESTORE: marcar hora de salida en el registro ========
      await guardar(
        updateDoc(doc(db, COL.accesos, id), {
          horaSalida: serverTimestamp(),
          guardiaSalida: state.guardia,
          observacionesSalida: r.datos.obs || ""
        })
      );
      toast(`Salida registrada: ${a.visitante}`, "success");
    } catch (err) {
      toast(errorAmigable(err), "error");
    }
  });
}

$("#buscar-accesos").addEventListener("input", (e) => {
  state.filtroAccesos = e.target.value;
  renderAccesos();
});

/* ---------------------------------------------------------------------
   11. RONDINES E INCIDENCIAS (Storage + Firestore)
   --------------------------------------------------------------------- */
const formInc = $("#form-incidencia");
formInc.punto.innerHTML = CONFIG.puntosRondin.map((p) => `<option>${esc(p)}</option>`).join("");

function abrirFormIncidencia() {
  irA("rondin");
  formInc.hidden = false;
  setTimeout(() => formInc.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
}
function cerrarFormIncidencia() {
  formInc.hidden = true;
  formInc.reset();
  limpiarFotos("incidencia");
  $("#incidencia-error").textContent = "";
}
$$("[data-abrir-incidencia]").forEach((b) => b.addEventListener("click", abrirFormIncidencia));
$("#cerrar-incidencia").addEventListener("click", cerrarFormIncidencia);

function obtenerGPS() {
  if (!navigator.geolocation) return Promise.resolve(null);
  return new Promise((res) =>
    navigator.geolocation.getCurrentPosition(
      (p) => res({ latitude: p.coords.latitude, longitude: p.coords.longitude, precisionM: Math.round(p.coords.accuracy) }),
      () => res(null),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
    )
  );
}

formInc.addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#incidencia-error");
  err.textContent = "";

  const tipo = formInc.tipo.value;
  const notas = formInc.notas.value.trim();
  if (!tipo) return (err.textContent = "Selecciona el tipo de incidencia.");
  if (notas.length < 10) return (err.textContent = "Describe lo ocurrido (mínimo 10 caracteres).");

  const hayFotos = state.fotos.incidencia.some(Boolean);
  if (hayFotos && !navigator.onLine) return (err.textContent = "Sin internet no se pueden subir fotos. Quítalas o espera conexión.");

  await conCarga($("#btn-enviar-incidencia"), async () => {
    try {
      const gps = formInc.gps.checked ? await obtenerGPS() : null;

      // ---------- 1) FIREBASE STORAGE: subir fotos de evidencia ----------
      let fotos = [];
      if (hayFotos) {
        progreso.mostrar("Subiendo evidencia de la incidencia…");
        fotos = await subirFotos("incidencia", `incidencias_seguridad/${claveDia(new Date())}`, { tipo });
      }

      const punto = formInc.punto.value;
      const detalle = formInc.detalleUbicacion.value.trim();

      // ---------- 2) FIRESTORE: guardar el reporte en "incidencias_seguridad" ----------
      progreso.set(100, "Guardando reporte…");
      await guardar(
        addDoc(collection(db, COL.incidencias), {
          tipo,
          descripcion: notas,
          ubicacion: detalle ? `${punto} · ${detalle}` : punto,
          puntoRondin: punto,
          prioridad: formInc.prioridad.value,
          estatus: "abierta",
          origen: "rondin",
          fotos,
          fotoUrl: fotos[0]?.url || null,
          ubicacionGps: gps,
          guardia: state.guardia,
          uidGuardia: state.user?.uid || null,
          caseta: CONFIG.caseta,
          [CONFIG.campoFecha]: serverTimestamp()
        })
      );

      progreso.ocultar();
      aviso("ok");
      toast("Incidencia enviada a la administración.", "success");
      cerrarFormIncidencia();
    } catch (ex) {
      progreso.ocultar();
      console.error(ex);
      err.textContent = `No se pudo enviar: ${errorAmigable(ex)}`;
    }
  });
});

$("#btn-sin-novedad").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  const r = await abrirModal({
    titulo: "Rondín sin novedad",
    html: `<label class="field"><span class="field__label">Punto recorrido</span>
             <select name="punto">${CONFIG.puntosRondin.map((p) => `<option>${esc(p)}</option>`).join("")}</select></label>
           <label class="field"><span class="field__label">Nota (opcional)</span>
             <input name="nota" maxlength="200" placeholder="Ej. Todo en orden, luces funcionando"></label>`,
    ok: "Registrar punto",
    tipo: "success"
  });
  if (!r.ok) return;
  await conCarga(btn, async () => {
    try {
      const gps = await obtenerGPS();
      // ======== FIRESTORE: bitácora de rondín (queda cerrada, sin novedad) ========
      await guardar(
        addDoc(collection(db, COL.incidencias), {
          tipo: "Rondín sin novedad",
          descripcion: r.datos.nota || "Recorrido realizado sin novedad.",
          ubicacion: r.datos.punto,
          puntoRondin: r.datos.punto,
          prioridad: "baja",
          estatus: "cerrada",
          origen: "rondin",
          fotos: [],
          ubicacionGps: gps,
          guardia: state.guardia,
          uidGuardia: state.user?.uid || null,
          caseta: CONFIG.caseta,
          [CONFIG.campoFecha]: serverTimestamp()
        })
      );
      aviso("ok");
      toast(`Punto registrado: ${r.datos.punto}`, "success");
    } catch (err) {
      toast(errorAmigable(err), "error");
    }
  });
});

function renderBitacora() {
  const cont = $("#lista-bitacora");
  if (!state.cargado.bitacora) return;
  if (!state.bitacora.length) {
    cont.innerHTML = `<li class="empty">Sin registros de rondín hoy.</li>`;
    return;
  }
  const prio = { alta: ["Alta", "bad"], media: ["Media", "warn"], baja: ["Baja", "ok"] };
  cont.innerHTML = state.bitacora
    .map((i) => {
      const sinNovedad = /cerrad|atend|resuel/.test(normalizar(i.estatus));
      const [pTxt, pTipo] = prio[i.prioridad] || ["—", "neutral"];
      const foto = i.fotoUrl || i.fotos?.[0]?.url;
      const clase = sinNovedad ? "ok" : i.prioridad === "alta" ? "bad" : "warn";
      return `<li class="row row--${clase}">
        ${
          foto
            ? `<button type="button" class="row__thumb" data-foto="${esc(foto)}" data-titulo="${esc(i.tipo)}" aria-label="Ver foto"><img src="${esc(foto)}" alt="" loading="lazy"></button>`
            : `<span class="row__thumb">${icon(sinNovedad ? "check" : "alert")}</span>`
        }
        <div class="row__body">
          <div class="row__top">
            <span class="row__title">${esc(i.tipo || "Incidencia")}</span>
            ${sinNovedad ? badge(i.estatus === "cerrada" && i.tipo === "Rondín sin novedad" ? "Sin novedad" : "Atendida", "ok") : badge(`Prioridad ${pTxt}`, pTipo)}
          </div>
          <div class="row__meta">
            <span>${icon("pin")}${esc(i.ubicacion || "—")}</span>
            <span>${icon("clock")}${esc(hora(toDate(i[CONFIG.campoFecha])))}</span>
            <span>${icon("shield")}${esc(i.guardia || "—")}</span>
            ${i.fotos?.length > 1 ? `<span>${icon("image")}${i.fotos.length} fotos</span>` : ""}
          </div>
          ${i.descripcion ? `<p class="row__text">${esc(i.descripcion)}</p>` : ""}
        </div>
      </li>`;
    })
    .join("");
}

/* Delegación: ver fotos y registrar salida */
document.addEventListener("click", (e) => {
  const f = e.target.closest("[data-foto]");
  if (f) return verFoto(f.dataset.foto, f.dataset.titulo);
  const s = e.target.closest("[data-salida]");
  if (s && !s.disabled) registrarSalida(s.dataset.salida, s);
});

/* ---------------------------------------------------------------------
   12. LISTENERS EN TIEMPO REAL (registros del día)
   --------------------------------------------------------------------- */
function iniciarListeners() {
  state.unsubs.forEach((u) => u());
  state.unsubs = [];
  state.diaListeners = claveDia(new Date());
  const desde = Timestamp.fromDate(inicioDelDia());

  state.unsubs.push(
    // ======== FIRESTORE: accesos registrados desde las 00:00 de hoy ========
    onSnapshot(
      query(collection(db, COL.accesos), where(CONFIG.campoFecha, ">=", desde), orderBy(CONFIG.campoFecha, "desc")),
      (snap) => {
        state.accesos = mapDocs(snap);
        state.cargado.accesos = true;
        renderAccesos();
      },
      (err) => toast(`Accesos: ${errorAmigable(err)}`, "error", 6000)
    ),
    // ======== FIRESTORE: bitácora de rondines e incidencias de hoy ========
    onSnapshot(
      query(collection(db, COL.incidencias), where(CONFIG.campoFecha, ">=", desde), orderBy(CONFIG.campoFecha, "desc")),
      (snap) => {
        state.bitacora = mapDocs(snap);
        state.cargado.bitacora = true;
        renderBitacora();
      },
      (err) => toast(`Bitácora: ${errorAmigable(err)}`, "error", 6000)
    )
  );
}

function detenerListeners() {
  state.unsubs.forEach((u) => u());
  state.unsubs = [];
}

/* ---------------------------------------------------------------------
   13. SESIÓN, GUARDIA, RELOJ Y CONEXIÓN
   --------------------------------------------------------------------- */
function nombreGuardiaInicial(user) {
  let guardado = "";
  try { guardado = localStorage.getItem(`guardia:${user?.uid}`) || ""; } catch { /* sin almacenamiento */ }
  return guardado || user?.displayName || (user?.email ? user.email.split("@")[0] : "Guardia");
}

function pintarGuardia() {
  $("#guardia-nombre").textContent = state.guardia;
}

$("#btn-guardia").addEventListener("click", async () => {
  const r = await abrirModal({
    titulo: "Guardia en turno",
    html: `<label class="field"><span class="field__label">Nombre que aparecerá en los registros</span>
           <input name="nombre" required minlength="3" maxlength="60" value="${esc(state.guardia)}"></label>`,
    ok: "Guardar"
  });
  if (!r.ok || !r.datos.nombre) return;
  state.guardia = r.datos.nombre;
  try { localStorage.setItem(`guardia:${state.user?.uid}`, state.guardia); } catch { /* sin almacenamiento */ }
  pintarGuardia();
  toast(`Turno a nombre de ${state.guardia}`, "success");
});

function mostrarApp(user) {
  state.user = user;
  state.guardia = nombreGuardiaInicial(user);
  pintarGuardia();
  $("#caseta-nombre").textContent = CONFIG.caseta;
  $("#boot").hidden = true;
  $("#login").hidden = true;
  $("#app").hidden = false;
  $("#btn-salir").hidden = !CONFIG.requiereLogin;
  renderSlots("acceso");
  renderSlots("incidencia");
  irA(location.hash.replace("#", "") || "validar");
  iniciarListeners();
}

function mostrarLogin() {
  detenerListeners();
  $("#boot").hidden = true;
  $("#app").hidden = true;
  $("#login").hidden = false;
  setTimeout(() => $("#login-email").focus(), 50);
}

$("#form-login").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#login-error");
  err.textContent = "";
  const email = $("#login-email").value.trim();
  const pass = $("#login-pass").value;
  if (!email || !pass) return (err.textContent = "Escribe tu correo y contraseña.");
  await conCarga($("#btn-login"), async () => {
    try {
      await signInWithEmailAndPassword(auth, email, pass);
    } catch (ex) {
      const mapa = {
        "auth/invalid-credential": "Correo o contraseña incorrectos.",
        "auth/wrong-password": "Correo o contraseña incorrectos.",
        "auth/user-not-found": "Correo o contraseña incorrectos.",
        "auth/too-many-requests": "Demasiados intentos. Espera unos minutos.",
        "auth/network-request-failed": "Sin conexión a internet."
      };
      err.textContent = mapa[ex.code] || "No fue posible iniciar sesión.";
    }
  });
});

$("#btn-salir").addEventListener("click", async () => {
  const r = await abrirModal({ titulo: "Terminar turno", html: "<p>¿Cerrar sesión en este dispositivo?</p>", ok: "Cerrar sesión", tipo: "danger" });
  if (r.ok) await signOut(auth);
});

function tick() {
  const ahora = new Date();
  $("#reloj").textContent = ahora.toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  $("#fecha-hoy").textContent = fmt(ahora, { weekday: "short", day: "numeric", month: "short" });
  // A medianoche se reinician las listas "de hoy"
  if (state.user && state.diaListeners && state.diaListeners !== claveDia(ahora)) iniciarListeners();
}
setInterval(tick, 1000);
tick();

function conexion() {
  const on = navigator.onLine;
  $("#conn").classList.toggle("is-off", !on);
  $(".conn__txt").textContent = on ? "En línea" : "Sin internet";
}
window.addEventListener("online", () => { conexion(); toast("Conexión restablecida", "success"); });
window.addEventListener("offline", () => { conexion(); toast("Sin internet: los registros se guardarán y enviarán después.", "warning", 6000); });
conexion();

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!$("#scanner").hidden) cerrarEscaner();
  else if (!$("#modal").hidden) cerrarModal();
});

/* ---------------------------------------------------------------------
   14. ARRANQUE
   --------------------------------------------------------------------- */
onAuthStateChanged(auth, (user) => {
  if (user) mostrarApp(user);
  else if (CONFIG.requiereLogin) mostrarLogin();
});

if (!CONFIG.requiereLogin) {
  signInAnonymously(auth).catch((err) => {
    console.warn("Sesión anónima no disponible:", err);
    mostrarApp(null);
  });
}