// Checador Packatelas — KIOSCO web (sin servidor, sin APK).
// Muestra el QR, verifica la huella que firma el celular, toma la foto, decide la checada
// que toca y la manda a Google Sheets (las fotos se guardan en Drive desde el Apps Script).
'use strict';

const VERSION = '2.1';
const $ = (id) => document.getElementById(id);
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ===================== Tipos de checada =====================
const TIPOS = [
  { c: 'ENTRADA', e: 'ENTRADA', corta: 'Entrada', inicia: true },
  { c: 'SALIDA_COMIDA', e: 'SALIDA A COMER', corta: 'Salir a comer', inicia: false },
  { c: 'REGRESO_COMIDA', e: 'REGRESO DE COMER', corta: 'Regresar de comer', inicia: true },
  { c: 'SALIDA', e: 'SALIDA', corta: 'Salida', inicia: false },
];
const ORDEN = TIPOS.map((t) => t.c);
const POR_COD = Object.fromEntries(TIPOS.map((t) => [t.c, t]));
const POR_ETQ = Object.fromEntries(TIPOS.map((t) => [t.e, t]));
const PERFILES = [
  ['Oficina', ORDEN],
  ['Repartidor', ['ENTRADA', 'SALIDA_COMIDA', 'REGRESO_COMIDA']],
  ['Campo', ['ENTRADA', 'SALIDA']],
];
const ordenar = (l) => ORDEN.filter((c) => l.includes(c));
const nombrePerfil = (l) => {
  const o = ordenar(l).join();
  const p = PERFILES.find(([, t]) => t.join() === o);
  return p ? p[0] : ordenar(l).map((c) => POR_COD[c].corta).join(' · ');
};
/** Cuál toca según lo ya checado hoy. null = ya completó. Si se saltó una, sigue con la próxima. */
function siguiente(permitidos, hechas) {
  let p = ordenar(permitidos || []); if (!p.length) p = ORDEN;
  const h = hechas.filter((c) => POR_COD[c]);
  const ult = h[h.length - 1];
  if (!ult) return p[0];
  return p.find((c) => ORDEN.indexOf(c) > ORDEN.indexOf(ult) && !h.includes(c)) || null;
}

// ===================== Guardado local =====================
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* lleno o bloqueado */ } },
};
let cfg = Object.assign({ scriptUrl: '', token: '', kiosko: 'BASE', dispositivo: 'Kiosco', pin: '1234' }, LS.get('kc_cfg', {}));
let empleados = LS.get('kc_emp', []);
let hoy = LS.get('kc_hoy', { fecha: '', marcas: {} });   // marcas[numero] = [{ t: código, ts }]

// Cola de checadas por enviar (IndexedDB; si no hay, en memoria)
const Cola = (() => {
  let db = null; const mem = new Map();
  const abrir = () => db ? Promise.resolve(db) : new Promise((res, rej) => {
    const r = indexedDB.open('checador', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('cola', { keyPath: 'uuid' });
    r.onsuccess = () => res((db = r.result)); r.onerror = () => rej(r.error);
  });
  const op = async (modo, fn) => {
    try {
      const d = await abrir();
      return await new Promise((res, rej) => {
        const tx = d.transaction('cola', modo); const req = fn(tx.objectStore('cola'));
        tx.oncomplete = () => res(req && req.result); tx.onerror = () => rej(tx.error);
      });
    } catch (e) { return null; }
  };
  return {
    async poner(x) { mem.set(x.uuid, x); await op('readwrite', (s) => s.put(x)); },
    async todos() { const r = await op('readonly', (s) => s.getAll()); return r || [...mem.values()]; },
    async quitar(k) { mem.delete(k); await op('readwrite', (s) => s.delete(k)); },
  };
})();

// ===================== Datos de la página =====================
const ORIGEN = location.origin;
const RPID = location.hostname;
const PAGINA = new URL('./', location.href).href;   // donde vive index.html (la página del celular)
const scriptId = () => ((cfg.scriptUrl || '').match(/script\.google\.com\/(?:a\/)?macros\/(?:[^/]+\/)?s\/([A-Za-z0-9_-]+)\/(?:exec|dev)/) || [])[1] || '';
const configCompleta = () => !!(scriptId() && cfg.token && cfg.kiosko);
const pad = (n) => String(n).padStart(2, '0');
const fechaLocal = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const horaLocal = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const horaCorta = (ts) => new Date(ts).toLocaleTimeString('es-MX', { hour: 'numeric', minute: '2-digit' });
const b64u = (u8) => Verif.b64u.enc(u8);
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : b64u(crypto.getRandomValues(new Uint8Array(16))));

// ===================== Apps Script =====================
const SCRIPT_VIEJO = 'Tu Apps Script es una versión anterior. Pega el código nuevo de Checador-AppsScript.gs ' +
  'y publícalo en Implementar → Administrar implementaciones → lápiz → Versión: "Nueva versión"';
async function gas(datos) {
  const r = await fetch(cfg.scriptUrl, { method: 'POST', body: JSON.stringify(Object.assign({ token: cfg.token }, datos)) });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'error del script');
  return j;
}
async function gasGet(params) {
  const r = await fetch(cfg.scriptUrl + '?' + new URLSearchParams(params));
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'error del script');
  return j;
}

async function sincronizarEmpleados() {
  const j = await gas({ accion: 'empleados' });
  if (!Array.isArray(j.empleados)) throw new Error(SCRIPT_VIEJO);
  // conserva contadores locales más altos (por si aún no se envían)
  const prev = Object.fromEntries(empleados.filter((e) => e.cred).map((e) => [e.cred.id, e.cred.contador || 0]));
  empleados = j.empleados.map((e) => {
    if (e.cred && prev[e.cred.id] > (e.cred.contador || 0)) e.cred.contador = prev[e.cred.id];
    return e;
  });
  LS.set('kc_emp', empleados);
  pintarPie();
}

function renovarDia() {
  const f = fechaLocal();
  if (hoy.fecha !== f) { hoy = { fecha: f, marcas: {} }; LS.set('kc_hoy', hoy); sincronizarHoy().catch(() => {}); }
}
async function sincronizarHoy() {
  const f = fechaLocal();
  const j = await gas({ accion: 'hoy', fecha: f });
  if (!Array.isArray(j.checadas)) throw new Error(SCRIPT_VIEJO);
  const marcas = {};
  const agregar = (num, t, ts) => { (marcas[num] = marcas[num] || []).push({ t, ts }); };
  j.checadas.forEach((c) => {
    const tipo = POR_ETQ[c.tipo] || POR_COD[c.tipo];
    if (tipo) agregar(c.numero, tipo.c, new Date(`${f}T${c.hora}`).getTime());
  });
  // las que siguen en la cola local todavía no están en la hoja
  (await Cola.todos()).filter((r) => r.fecha === f).forEach((r) => agregar(r.numero, POR_ETQ[r.tipo].c, r.ts));
  Object.values(marcas).forEach((l) => l.sort((a, b) => a.ts - b.ts));
  hoy = { fecha: f, marcas };
  LS.set('kc_hoy', hoy);
}

// ===================== QR que cambia cada 20 s =====================
const VENTANA = 20, VENTANAS_VALIDAS = 5;
const retos = new Map();
const ventanaActual = () => Math.floor(Date.now() / 1000 / VENTANA);
function retoActual() {
  const v = ventanaActual();
  if (!retos.has(v)) retos.set(v, b64u(crypto.getRandomValues(new Uint8Array(16))));
  for (const k of [...retos.keys()]) if (k <= v - VENTANAS_VALIDAS) retos.delete(k);
  return retos.get(v);
}
function retoValido(r) {
  const v = ventanaActual();
  for (const [k, x] of retos) if (x === r && k > v - VENTANAS_VALIDAS) return true;
  return false;
}
function qrSvg(texto) {
  const q = qrcode(0, 'M'); q.addData(texto, 'Byte'); q.make();
  return q.createSvgTag({ cellSize: 4, margin: 1, scalable: true });
}
let retoMostrado = '';
function refrescarQr() {
  if (!configCompleta()) {
    $('qr').innerHTML = ''; retoMostrado = '';
    $('instr').classList.add('error');
    $('instr').textContent = 'Falta configurar el kiosco. Mantén presionado el reloj para entrar.';
    return;
  }
  $('instr').classList.remove('error');
  $('instr').textContent = 'Escanea con la cámara de tu celular y pon tu huella';
  const r = retoActual();
  const resta = VENTANA - (Math.floor(Date.now() / 1000) % VENTANA);
  $('barraQr').style.width = (resta * 100 / VENTANA) + '%';
  if (r === retoMostrado) return;
  retoMostrado = r;
  const url = `${PAGINA}#k=${encodeURIComponent(cfg.kiosko)}&c=${r}&s=${scriptId()}`;
  $('qr').innerHTML = qrSvg(url);
  $('qr').dataset.url = url;
}

// ===================== Reloj y pie =====================
function reloj() {
  const d = new Date();
  $('reloj').textContent = d.toLocaleTimeString('es-MX', { hour: 'numeric', minute: '2-digit' });
  const f = d.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' });
  $('fecha').textContent = f.charAt(0).toUpperCase() + f.slice(1);
}
let conectado = null, porEnviar = 0, errorEnvio = '', camaraOk = false;
function pintarPie() {
  const partes = [esc(cfg.dispositivo), `${empleados.length} ${empleados.length === 1 ? 'empleado' : 'empleados'}`];
  if (porEnviar) partes.push(`${porEnviar} por enviar`);
  if (conectado === false) partes.push('<span class="mal">⚠ el checador no tiene internet</span>');
  if (!camaraOk) partes.push('<span class="mal">⚠ sin cámara: no se tomarán fotos</span>');
  $('pie').innerHTML = partes.join(' · ');
}

// ===================== Cámara (solo para la foto de cada checada) =====================
let iniciandoCamara = false;
async function iniciarCamara() {
  if (iniciandoCamara) return;
  iniciandoCamara = true;
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
    // iOS detiene la cámara al bloquear la pantalla o cambiar de app: se vuelve a abrir sola
    s.getVideoTracks().forEach((t) => t.addEventListener('ended', () => { camaraOk = false; pintarPie(); setTimeout(iniciarCamara, 1000); }));
    const v = $('cam');
    v.setAttribute('playsinline', ''); v.muted = true;
    v.srcObject = s;
    await v.play().catch(() => {});
    camaraOk = true; $('cajaCam').classList.remove('sin');
  } catch (e) {
    camaraOk = false; $('cajaCam').classList.add('sin');
  } finally { iniciandoCamara = false; }
  pintarPie();
}
function camaraViva() {
  const s = $('cam').srcObject;
  return !!(s && s.getVideoTracks().some((t) => t.readyState === 'live'));
}
function capturarFoto() {
  const v = $('cam');
  if (!camaraViva()) { iniciarCamara(); return null; }
  if (v.paused) v.play().catch(() => {});
  if (!v.videoWidth) return null;
  const lado = Math.min(v.videoWidth, v.videoHeight), c = document.createElement('canvas');
  c.width = c.height = 320;
  c.getContext('2d').drawImage(v, (v.videoWidth - lado) / 2, (v.videoHeight - lado) / 2, lado, lado, 0, 0, 320, 320);
  return c.toDataURL('image/jpeg', 0.75);
}
// ===================== Mensajes de los celulares (vía Apps Script) =====================
const vistos = new Set();
async function bucleMensajes() {
  for (;;) {
    if (configCompleta() && !document.hidden) {
      try {
        const j = await gasGet({ accion: 'pendientes', k: cfg.kiosko, token: cfg.token });
        const res = [];
        for (const p of j.pendientes || []) {
          if (vistos.has(p.id)) continue;
          vistos.add(p.id);
          let r;
          try { r = await manejar(p); } catch (e) { r = { id: p.id, exito: false, mensaje: 'Error en el kiosco: ' + e.message }; }
          if (r) res.push(r);
        }
        if (res.length) await gas({ accion: 'resultados', k: cfg.kiosko, resultados: res });
        if (conectado !== true) { conectado = true; pintarPie(); }
      } catch (e) {
        if (conectado !== false) { conectado = false; pintarPie(); }
      }
    }
    await dormir(2500);
  }
}
async function responder(r) {
  for (let i = 0; i < 3; i++) {
    try { await gas({ accion: 'resultados', k: cfg.kiosko, resultados: [r] }); return; } catch (e) { await dormir(1500 * (i + 1)); }
  }
}
function manejar(p) {
  if (p.tipo === 'checar') return procesarChecada(p.payload, p.id);
  if (p.tipo === 'alta' && alta) return procesarAlta(p.payload, p.id);
  return { id: p.id, exito: false, mensaje: 'Para registrar tu celular, el encargado tiene que abrir "Registrar celular" en el kiosco.' };
}
const opVerif = (retoOk) => ({ origen: ORIGEN, rpId: RPID, retoValido: retoOk });

// ===================== Checar =====================
const enPantalla = new Set();
async function procesarChecada(payload, relayId) {
  const fallo = (msg) => {
    if (panelLibre()) mostrarAviso('No se pudo checar', msg);
    return relayId ? { id: relayId, exito: false, mensaje: msg } : null;
  };
  let credId;
  try { credId = Verif.credIdDe(payload); } catch (e) { return fallo('Código no reconocido. Intenta de nuevo.'); }
  let emp = empleados.find((e) => e.cred && e.cred.id === credId);
  if (!emp) { try { await sincronizarEmpleados(); } catch (e) {} emp = empleados.find((e) => e.cred && e.cred.id === credId); }
  if (!emp) return fallo('Este celular no está registrado. Pide al encargado que lo registre en el kiosco.');

  let contador;
  try { contador = await Verif.verificarChecada(payload, emp.cred, opVerif(retoValido)); }
  catch (e) { if (e instanceof Verif.ErrorHuella) return fallo(e.paraCelular); throw e; }
  emp.cred.contador = contador; LS.set('kc_emp', empleados);

  renovarDia();
  const marcas = hoy.marcas[emp.numero] || [];
  const ult = marcas[marcas.length - 1];
  if (enPantalla.has(emp.numero) || (ult && Date.now() - ult.ts < 60000)) {
    const etq = ult ? POR_COD[ult.t].e : 'checada';
    if (!relayId && panelLibre()) mostrarAviso('Ya estaba registrada', `${emp.nombre}: tu ${etq.toLowerCase()} ya quedó guardada.`);
    return relayId ? { id: relayId, exito: true, mensaje: 'Ya estaba registrada', nombre: emp.nombre, tipo: etq, hora: horaCorta(ult ? ult.ts : Date.now()) } : null;
  }
  const sig = siguiente(emp.checadas, marcas.map((m) => m.t));
  if (!sig) return fallo(`${emp.nombre}: ya registraste todas tus checadas de hoy. Si es un error, avisa al encargado.`);

  const foto = capturarFoto();
  enPantalla.add(emp.numero);
  encolar({
    c: { uuid: uuid(), numero: emp.numero, nombre: emp.nombre, tipo: sig, ts: Date.now(), foto, credId, contador },
    relayId, opciones: emp.checadas,
  });
  return null;   // se responde al celular cuando se confirma
}

// ===================== Panel de confirmación =====================
let pendiente = null, temporizador = null;
const cola = [];
const visible = (id) => !$(id).classList.contains('oculto');
const panelLibre = () => !pendiente && !visible('vResultado') && !alta && !visible('vAdmin') && !visible('vEmp') && !visible('vPin');
function encolar(e) { if (panelLibre()) mostrarConfirmacion(e); else cola.push(e); }

function cuenta(ms, fin) {
  clearInterval(temporizador);
  const ini = Date.now();
  $('barraRes').style.width = '100%';
  temporizador = setInterval(() => {
    const p = Math.max(0, 1 - (Date.now() - ini) / ms);
    $('barraRes').style.width = (p * 100) + '%';
    if (p <= 0) { clearInterval(temporizador); fin(); }
  }, 50);
}
function pintarTipo(tipo) {
  const t = POR_COD[tipo];
  $('rTipo').textContent = t.e;
  $('rTipo').className = 'k-tipo ' + (t.inicia ? 'ok' : 'ambar');
  [...$('rTipos').children].forEach((b) => b.classList.toggle('sel', b.dataset.t === tipo));
}
function mostrarConfirmacion(e) {
  pendiente = e;
  const c = e.c;
  $('rFoto').src = c.foto || '';
  $('rNombre').textContent = c.nombre;
  $('rDetalle').textContent = `No. ${c.numero} · ${horaCorta(c.ts)} · huella del celular`;
  const opciones = ordenar(e.opciones);
  $('rTipos').innerHTML = opciones.length > 1
    ? opciones.map((t) => `<button type="button" data-t="${t}">${esc(POR_COD[t].corta)}</button>`).join('') : '';
  pintarTipo(c.tipo);
  $('rAcciones').classList.remove('oculto');
  $('vResultado').classList.remove('oculto');
  pitido();
  cuenta(5000, guardarPendiente);
}
$('rTipos').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-t]'); if (!b || !pendiente) return;
  pendiente.c.tipo = b.dataset.t; pintarTipo(b.dataset.t);
  cuenta(5000, guardarPendiente);
});
$('bConfirmar').addEventListener('click', () => guardarPendiente());

async function guardarPendiente() {
  const e = pendiente; if (!e) return;
  pendiente = null; clearInterval(temporizador);
  const c = e.c;
  enPantalla.delete(c.numero);
  (hoy.marcas[c.numero] = hoy.marcas[c.numero] || []).push({ t: c.tipo, ts: c.ts });
  LS.set('kc_hoy', hoy);
  const d = new Date(c.ts);
  await Cola.poner({
    uuid: c.uuid, fecha: fechaLocal(d), hora: horaLocal(d), ts: c.ts, numero: c.numero, nombre: c.nombre,
    tipo: POR_COD[c.tipo].e, similitud: '', metodo: 'Huella + QR', ubicacion: '', dispositivo: cfg.dispositivo,
    foto: c.foto ? c.foto.split(',')[1] : null, credId: c.credId, contador: c.contador,
  });
  enviarCola();
  if (e.relayId) responder({ id: e.relayId, exito: true, nombre: c.nombre, tipo: POR_COD[c.tipo].e, hora: horaCorta(c.ts) });
  $('rAcciones').classList.add('oculto'); $('rTipos').innerHTML = '';
  $('rDetalle').textContent = '✓ Registrado';
  cuenta(1500, cerrarResultado);
}
function mostrarAviso(titulo, detalle) {
  $('rFoto').removeAttribute('src');
  $('rTipo').textContent = titulo; $('rTipo').className = 'k-tipo error';
  $('rNombre').textContent = ''; $('rDetalle').textContent = detalle;
  $('rTipos').innerHTML = ''; $('rAcciones').classList.add('oculto');
  $('vResultado').classList.remove('oculto');
  cuenta(3500, cerrarResultado);
}
function cerrarResultado() {
  $('vResultado').classList.add('oculto');
  pintarPie();
  if (cola.length && panelLibre()) mostrarConfirmacion(cola.shift());
}
let audio;
// iOS solo deja sonar audio después de que alguien toca la pantalla: se activa con el primer toque
function activarAudio() {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
    const b = audio.createBuffer(1, 1, 22050), src = audio.createBufferSource();
    src.buffer = b; src.connect(audio.destination); src.start(0);
  } catch (e) { /* sin sonido */ }
}
document.addEventListener('pointerdown', activarAudio, { passive: true });
function pitido() {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
    const o = audio.createOscillator(), g = audio.createGain();
    o.frequency.value = 880; g.gain.value = 0.15; o.connect(g); g.connect(audio.destination);
    o.start(); o.stop(audio.currentTime + 0.15);
  } catch (e) { /* sin sonido */ }
}

// ===================== Envío a Google Sheets =====================
let enviando = false;
async function enviarCola() {
  if (enviando || !configCompleta()) return;
  enviando = true;
  try {
    let lista = (await Cola.todos()).sort((a, b) => a.ts - b.ts);
    porEnviar = lista.length; pintarPie();
    while (lista.length) {
      const lote = lista.slice(0, 10);
      const j = await gas({ dispositivo: cfg.dispositivo, registros: lote });
      for (const u of j.confirmados || []) await Cola.quitar(u);
      if (!(j.confirmados || []).length) throw new Error('el script no confirmó');
      lista = (await Cola.todos()).sort((a, b) => a.ts - b.ts);
      porEnviar = lista.length; pintarPie();
    }
    errorEnvio = '';
  } catch (e) {
    errorEnvio = e.message || String(e);
  } finally {
    enviando = false;
    porEnviar = (await Cola.todos()).length; pintarPie();
  }
}

// ===================== Registrar celular =====================
let alta = null;   // { numero, nombre, reto, desde, listo }
function abrirAlta(emp) {
  if (!configCompleta()) return toast('Primero completa la Configuración');
  alta = { numero: emp.numero, nombre: emp.nombre, reto: '', desde: 0, listo: false };
  $('aTitulo').textContent = 'Registrar celular de ' + emp.nombre;
  $('aListo').classList.add('oculto'); $('aCaja').classList.remove('oculto');
  nuevoRetoAlta();
  $('vAdmin').classList.add('oculto');
  $('vAlta').classList.remove('oculto');
}
function nuevoRetoAlta() {
  alta.reto = b64u(crypto.getRandomValues(new Uint8Array(16))); alta.desde = Date.now();
  const url = `${PAGINA}#a=1&k=${encodeURIComponent(cfg.kiosko)}&c=${alta.reto}&s=${scriptId()}` +
    `&u=${encodeURIComponent(alta.numero)}&n=${encodeURIComponent(alta.nombre)}`;
  $('aQr').innerHTML = qrSvg(url);
  $('aQr').dataset.url = url;
  $('aEstado').textContent = 'Esperando al celular…';
}
setInterval(() => { if (alta && !alta.listo && Date.now() - alta.desde > 5 * 60000) nuevoRetoAlta(); }, 10000);
function cerrarAlta() {
  alta = null;
  $('vAlta').classList.add('oculto');
  abrirAdmin('tEmp');
}
$('bCerrarAlta').addEventListener('click', cerrarAlta);

async function procesarAlta(payload, relayId) {
  const a = alta;
  const fallo = (msg) => { $('aEstado').textContent = '⚠ ' + msg; return relayId ? { id: relayId, exito: false, mensaje: msg } : null; };
  if (!a || a.listo) return fallo('Este registro ya se completó.');
  let cred;
  try { cred = await Verif.verificarAlta(payload, opVerif((r) => r === a.reto)); }
  catch (e) { if (e instanceof Verif.ErrorHuella) return fallo(e.paraCelular); throw e; }
  const otro = empleados.find((e) => e.cred && e.cred.id === cred.id && e.numero !== a.numero);
  if (otro) return fallo('Este celular ya está registrado a nombre de ' + otro.nombre + '.');
  try {
    const j = await gas({ accion: 'guardarCelular', numero: a.numero, cred });
    empleados = j.empleados; LS.set('kc_emp', empleados);
  } catch (e) { return fallo('El kiosco no pudo guardar el registro (' + e.message + '). Intenta de nuevo.'); }
  a.listo = true;
  $('aCaja').classList.add('oculto');
  $('aListo').textContent = '✓ Celular de ' + a.nombre + ' registrado';
  $('aListo').classList.remove('oculto');
  $('aEstado').textContent = 'Ya puede checar escaneando el QR del checador.';
  setTimeout(() => { if (alta === a) cerrarAlta(); }, 3500);
  return relayId ? { id: relayId, exito: true, nombre: a.nombre } : null;
}

// ===================== Administración =====================
function toast(t, ms = 3500) {
  $('toast').textContent = t; $('toast').classList.remove('oculto');
  clearTimeout(toast.t); toast.t = setTimeout(() => $('toast').classList.add('oculto'), ms);
}
// Mantener presionado el reloj 1.5 s
(() => {
  let t;
  const ini = () => { t = setTimeout(pedirPin, 1500); };
  const fin = () => clearTimeout(t);
  const c = $('cabecera');
  c.addEventListener('pointerdown', ini); ['pointerup', 'pointerleave', 'pointercancel'].forEach((e) => c.addEventListener(e, fin));
  c.addEventListener('contextmenu', (e) => e.preventDefault());
})();
function pedirPin() {
  if (!configCompleta()) return abrirAdmin('tCfg');
  $('pIn').value = ''; $('vPin').classList.remove('oculto'); setTimeout(() => $('pIn').focus(), 50);
}
$('fPin').addEventListener('submit', (e) => {
  e.preventDefault();
  if ($('pIn').value === String(cfg.pin)) { $('vPin').classList.add('oculto'); abrirAdmin('tEmp'); }
  else { $('pIn').value = ''; toast('PIN incorrecto'); }
});
$('bPinCancelar').addEventListener('click', () => $('vPin').classList.add('oculto'));

function abrirAdmin(tab) {
  $('vAdmin').classList.remove('oculto');
  mostrarTab(tab || 'tEmp');
}
function mostrarTab(id) {
  document.querySelectorAll('.k-tabs button').forEach((b) => b.classList.toggle('activo', b.dataset.tab === id));
  ['tEmp', 'tCfg', 'tEst'].forEach((t) => $(t).classList.toggle('oculto', t !== id));
  if (id === 'tEmp') { pintarEmpleados(); if (configCompleta()) sincronizarEmpleados().then(pintarEmpleados).catch((e) => toast('Sin conexión: ' + e.message)); }
  if (id === 'tCfg') { $('cUrl').value = cfg.scriptUrl; $('cToken').value = cfg.token; $('cKiosko').value = cfg.kiosko; $('cDisp').value = cfg.dispositivo; $('cPin').value = cfg.pin; }
  if (id === 'tEst') pintarEstado();
}
document.querySelectorAll('.k-tabs button').forEach((b) => b.addEventListener('click', () => mostrarTab(b.dataset.tab)));
$('bSalirAdmin').addEventListener('click', () => {
  if (!configCompleta()) return toast('Completa la configuración primero');
  $('vAdmin').classList.add('oculto');
  if (cola.length && panelLibre()) mostrarConfirmacion(cola.shift());
});

function pintarEmpleados() {
  const l = [...empleados].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  $('listaEmp').innerHTML = l.map((e) => `
    <div class="k-emp" data-n="${esc(e.numero)}">
      <div class="datos">
        <div class="n">${esc(e.nombre)} <span class="s">#${esc(e.numero)}</span>
          ${e.cred ? '<span class="pill si">Celular registrado</span>' : '<span class="pill no">Sin celular</span>'}</div>
        <div class="s">Checa: ${esc(nombrePerfil(e.checadas))}</div>
        <div class="s">${e.horaEntrada ? 'Entra ' + esc(e.horaEntrada) : '<span class="mal">Sin hora de entrada</span>'} · ${esc(e.dias || 'días sin capturar')} · comida ${esc(e.comida || 60)} min</div>
      </div>
      <div class="k-fila-btn">
        <button class="k-chico ${e.cred ? '' : 'pri'}" data-a="cel">${e.cred ? 'Cambiar celular' : 'Registrar celular'}</button>
        <button class="k-chico" data-a="editar">Editar</button>
        ${e.cred ? '<button class="k-chico peligro" data-a="quitar">Quitar celular</button>' : ''}
        <button class="k-chico peligro" data-a="borrar">Eliminar</button>
      </div>
    </div>`).join('') || '<div class="k-nota">Aún no hay empleados. Toca "+ Empleado".</div>';
}
$('listaEmp').addEventListener('click', async (ev) => {
  const b = ev.target.closest('button[data-a]'); if (!b) return;
  const e = empleados.find((x) => x.numero === b.closest('.k-emp').dataset.n); if (!e) return;
  try {
    if (b.dataset.a === 'cel') {
      if (e.cred && !confirm(`El celular actual de ${e.nombre} dejará de funcionar. ¿Registrar otro?`)) return;
      abrirAlta(e);
    } else if (b.dataset.a === 'editar') abrirEmpleado(e);
    else if (b.dataset.a === 'quitar') {
      if (!confirm(`¿Quitar el celular de ${e.nombre}? No podrá checar hasta registrar otro.`)) return;
      empleados = (await gas({ accion: 'guardarCelular', numero: e.numero, cred: null })).empleados; LS.set('kc_emp', empleados); pintarEmpleados();
    } else if (b.dataset.a === 'borrar') {
      if (!confirm(`¿Eliminar a ${e.nombre}? Sus checadas ya registradas se conservan.`)) return;
      empleados = (await gas({ accion: 'borrarEmpleado', numero: e.numero })).empleados; LS.set('kc_emp', empleados); pintarEmpleados();
    }
  } catch (err) { toast('No se pudo: ' + err.message); }
});
$('bRecargar').addEventListener('click', () => sincronizarEmpleados().then(() => { pintarEmpleados(); toast('Lista actualizada'); }).catch((e) => toast('Sin conexión: ' + e.message)));

// ---- Diálogo de empleado
let editando = null;
const DIAS = [['L', 'Lun'], ['M', 'Mar'], ['Mi', 'Mié'], ['J', 'Jue'], ['V', 'Vie'], ['S', 'Sáb'], ['D', 'Dom']];
/** "L,M,Mi,J,V", "L-V", "L-S" -> ['L','M',...] */
function diasDe(texto) {
  const s = String(texto || '').replace(/\s+/g, '').toUpperCase();
  if (/^L-V$|^LUNESAVIERNES$/.test(s)) return ['L', 'M', 'Mi', 'J', 'V'];
  if (/^L-S$|^LUNESASABADO$|^LUNESASÁBADO$/.test(s)) return ['L', 'M', 'Mi', 'J', 'V', 'S'];
  const ok = DIAS.map(([d]) => d.toUpperCase());
  return s.split(/[,;\/]+/).filter((x) => ok.includes(x)).map((x) => DIAS[ok.indexOf(x)][0]);
}
$('eDias').innerHTML = DIAS.map(([d, n]) => `<label><input type="checkbox" value="${d}"> ${n}</label>`).join('');
$('eDiasAtajos').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-d]'); if (!b) return;
  const l = b.dataset.d.split(',');
  $('eDias').querySelectorAll('input').forEach((i) => (i.checked = l.includes(i.value)));
});
$('ePerfiles').innerHTML = PERFILES.map(([n]) => `<button type="button" class="k-chico" data-p="${n}">${n}</button>`).join('');
$('eTipos').innerHTML = TIPOS.map((t) => `<label><input type="checkbox" value="${t.c}"> ${esc(t.corta)}</label>`).join('');
$('ePerfiles').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-p]'); if (!b) return;
  const tipos = PERFILES.find(([n]) => n === b.dataset.p)[1];
  $('eTipos').querySelectorAll('input').forEach((i) => (i.checked = tipos.includes(i.value)));
});
function abrirEmpleado(e) {
  editando = e || null;
  $('eTitulo').textContent = e ? 'Editar empleado' : 'Nuevo empleado';
  $('eNum').value = e ? e.numero : ''; $('eNom').value = e ? e.nombre : '';
  const tipos = e ? e.checadas : ORDEN;
  $('eTipos').querySelectorAll('input').forEach((i) => (i.checked = tipos.includes(i.value)));
  const h = (e && e.horaEntrada || '').match(/^(\d{1,2}):(\d{2})/);
  $('eHora').value = h ? h[1].padStart(2, '0') + ':' + h[2] : '';
  const dias = e && e.dias ? diasDe(e.dias) : ['L', 'M', 'Mi', 'J', 'V', 'S'];
  $('eDias').querySelectorAll('input').forEach((i) => (i.checked = dias.includes(i.value)));
  $('eComida').value = e && e.comida !== '' && e.comida != null ? e.comida : 60;
  $('eGuardarCel').textContent = e && e.cred ? 'Guardar' : 'Guardar y registrar celular';
  $('eMsg').classList.add('oculto');
  $('vEmp').classList.remove('oculto');
}
$('bNuevo').addEventListener('click', () => abrirEmpleado(null));
$('eCancelar').addEventListener('click', () => $('vEmp').classList.add('oculto'));
async function guardarEmpleado(conCelular) {
  const datos = {
    accion: 'guardarEmpleado', numero: $('eNum').value.trim(), nombre: $('eNom').value.trim(),
    numeroAnterior: editando ? editando.numero : undefined,
    checadas: [...$('eTipos').querySelectorAll('input:checked')].map((i) => i.value),
    horaEntrada: $('eHora').value.replace(/^0(\d):/, '$1:'),
    dias: [...$('eDias').querySelectorAll('input:checked')].map((i) => i.value).join(','),
    comida: $('eComida').value === '' ? 60 : Number($('eComida').value),
  };
  const msg = (t) => { $('eMsg').textContent = t; $('eMsg').classList.remove('oculto'); };
  if (!datos.numero || !datos.nombre) return msg('Número y nombre son obligatorios.');
  if (!datos.checadas.length) return msg('Marca al menos una checada.');
  if (!datos.horaEntrada) return msg('Pon la hora de entrada (se usa para calcular retrasos).');
  if (!datos.dias) return msg('Marca los días que trabaja (los demás no cuentan como falta).');
  if (!editando && empleados.some((x) => x.numero === datos.numero)) return msg('Ya existe el número ' + datos.numero + '.');
  try {
    empleados = (await gas(datos)).empleados; LS.set('kc_emp', empleados);
  } catch (e) { return msg('No se pudo guardar: ' + e.message); }
  $('vEmp').classList.add('oculto');
  pintarEmpleados();
  const emp = empleados.find((x) => x.numero === datos.numero);
  if (conCelular && emp && !emp.cred) abrirAlta(emp);
}
$('fEmp').addEventListener('submit', (e) => { e.preventDefault(); guardarEmpleado(true); });
$('eGuardar').addEventListener('click', () => guardarEmpleado(false));

// ---- Importar respaldo de la app Android (conserva los celulares registrados)
$('fImportar').addEventListener('change', async (ev) => {
  const f = ev.target.files[0]; ev.target.value = ''; if (!f) return;
  try {
    const datos = JSON.parse(await f.text());
    const lista = datos.empleados || [];
    let n = 0, cel = 0;
    for (const e of lista) {
      toast(`Importando ${++n} de ${lista.length}…`, 60000);
      const checadas = String(e.checadas || ORDEN.join(',')).split(',').map((s) => s.trim()).filter((s) => POR_COD[s]);
      empleados = (await gas({ accion: 'guardarEmpleado', numero: String(e.numero), nombre: e.nombre, checadas: checadas.length ? checadas : ORDEN })).empleados;
      if (e.credencial && e.credencial.llave) {
        const jwk = await Verif.jwkDeSpki(e.credencial.llave, Number(e.credencial.alg));
        empleados = (await gas({ accion: 'guardarCelular', numero: String(e.numero),
          cred: { id: e.credencial.id, jwk, alg: Number(e.credencial.alg), contador: Number(e.credencial.contador || 0) } })).empleados;
        cel++;
      }
    }
    LS.set('kc_emp', empleados); pintarEmpleados();
    toast(`Listo: ${lista.length} ${lista.length === 1 ? 'empleado importado' : 'empleados importados'} (${cel} con celular).`, 6000);
  } catch (e) { toast('No se pudo importar: ' + e.message, 6000); }
});

// ---- Configuración
$('fCfg').addEventListener('submit', async (e) => {
  e.preventDefault();
  const nuevo = {
    scriptUrl: $('cUrl').value.trim(), token: $('cToken').value.trim(),
    kiosko: $('cKiosko').value.trim().replace(/\s+/g, '-'), dispositivo: $('cDisp').value.trim(), pin: $('cPin').value.trim(),
  };
  const m = $('cMsg');
  const aviso = (t, tipo) => { m.textContent = t; m.className = 'aviso ' + tipo; };
  const anterior = cfg;
  cfg = Object.assign({}, cfg, nuevo);
  if (!scriptId()) { cfg = anterior; return aviso('La URL de Apps Script no es válida. Debe ser la que termina en /exec.', 'error'); }
  aviso('Probando conexión…', 'info');
  try {
    await sincronizarEmpleados();
    LS.set('kc_cfg', cfg);
    retoMostrado = '';
    sincronizarHoy().catch(() => {});
    enviarCola();
    aviso(`✓ Conectado. ${empleados.length} empleados en la hoja.`, 'info');
  } catch (err) {
    LS.set('kc_cfg', cfg);
    aviso(err.message === SCRIPT_VIEJO ? 'Se guardó, pero ' + SCRIPT_VIEJO.charAt(0).toLowerCase() + SCRIPT_VIEJO.slice(1) + '.'
      : 'Se guardó, pero no se pudo conectar: ' + err.message + '. Revisa la URL, el token y que el script esté publicado como "Cualquier usuario".', 'error');
  }
});

// ---- Estado
async function pintarEstado() {
  const pend = (await Cola.todos()).length;
  $('estado').innerHTML = `
    <div>Versión del kiosco: <b>${VERSION}</b></div>
    <div>Conexión con la hoja: <b>${conectado === false ? 'sin internet' : conectado ? 'en línea' : '—'}</b></div>
    <div>Checadas por enviar: <b>${pend}</b>${errorEnvio ? ` <span class="mal">(último error: ${esc(errorEnvio)})</span>` : ''}</div>
    <div>Cámara: <b>${camaraOk ? 'funcionando' : 'sin acceso (revisa el permiso de cámara)'}</b></div>
    <div>Página del celular: <b>${esc(PAGINA)}</b></div>
    <div>Dispositivo: <b>${ES_IOS ? 'iPhone / iPad' : 'Android u otro'}</b> · ${modoApp() ? 'abierto como app' : 'abierto en el navegador'}</div>`;
  $('instKiosco').innerHTML = ES_IOS ? INST_IOS : INST_ANDROID;
  $('bCompleta').hidden = ES_IOS;   // en iOS la pantalla completa es abrirlo desde el ícono
}
$('bEnviar').addEventListener('click', async () => { await enviarCola(); pintarEstado(); toast(errorEnvio ? 'No se pudo enviar: ' + errorEnvio : 'Enviado ✓'); });
$('bCompleta').addEventListener('click', () => document.documentElement.requestFullscreen && document.documentElement.requestFullscreen().catch(() => {}));

// ===================== Instrucciones para dejarlo como kiosco =====================
const ES_IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const modoApp = () => window.matchMedia('(display-mode: standalone)').matches || window.matchMedia('(display-mode: fullscreen)').matches || navigator.standalone === true;
const INST_IOS = `<b>iPhone / iPad con Chrome</b><ol>
  <li>Toca <b>Compartir</b> (cuadro con flecha, junto a la barra de direcciones) → <b>Agregar a pantalla de inicio</b>.</li>
  <li>Abre el checador <b>desde ese ícono</b> (sin barras del navegador). La primera vez vuelve a capturar la configuración y permite la cámara.</li>
  <li>Ajustes → Pantalla y brillo → <b>Bloqueo automático: Nunca</b>.</li>
  <li>Ajustes → Accesibilidad → <b>Acceso guiado</b>: actívalo y pon un código. Con el checador abierto, presiona 3 veces el botón lateral (o el de inicio) → Iniciar. Así nadie puede salir del checador.</li>
  <li>Toca la pantalla una vez al arrancar para activar el sonido.</li></ol>`;
const INST_ANDROID = `<b>Android con Chrome</b><ol>
  <li>Menú ⋮ → <b>Agregar a pantalla principal</b> y ábrelo desde ese ícono.</li>
  <li>Ajustes → Seguridad → <b>Fijar app</b> para que nadie salga del checador.</li></ol>`;

// ===================== Pantalla siempre encendida =====================
let wake = null;
async function mantenerEncendida() { try { if ('wakeLock' in navigator && !document.hidden) wake = await navigator.wakeLock.request('screen'); } catch (e) {} }
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { mantenerEncendida(); renovarDia(); if (!camaraViva()) iniciarCamara(); }
});
setInterval(() => { if (!document.hidden && !camaraViva()) iniciarCamara(); }, 30000);

// ===================== Arranque =====================
(async () => {
  reloj(); setInterval(reloj, 1000);
  refrescarQr(); setInterval(refrescarQr, 250);
  pintarPie();
  mantenerEncendida();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  iniciarCamara();
  if (!configCompleta()) { abrirAdmin('tCfg'); }
  else {
    renovarDia();
    sincronizarEmpleados().catch(() => {});
    sincronizarHoy().catch(() => {});
  }
  bucleMensajes();
  enviarCola(); setInterval(enviarCola, 30000);
  setInterval(() => { if (configCompleta()) sincronizarEmpleados().catch(() => {}); }, 10 * 60000);
})();
