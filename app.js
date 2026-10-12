// Checador Packatelas — página para el celular del repartidor.
// No necesita servidor: el kiosco verifica la huella y Google Apps Script solo pasa los mensajes.
//
//  Checar:  #k=<kiosco>&c=<reto>&s=<id del Apps Script>
//  Alta:    #a=1&k=<kiosco>&c=<reto>&s=<id>&u=<no. empleado>&n=<nombre>
'use strict';

const $ = (id) => document.getElementById(id);
const P = Object.fromEntries(new URLSearchParams(location.hash.slice(1)));
const ES_ALTA = P.a === '1';
const RELAY = P.s ? 'https://script.google.com/macros/s/' + encodeURIComponent(P.s) + '/exec' : '';

// ---------- utilidades
const b64uABuf = (s) => {
  s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '=';
  const bin = atob(s), u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u.buffer;
};
const bufAB64u = (buf) => {
  const u = new Uint8Array(buf); let s = '';
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const guardar = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
const leer = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } };
const idAleatorio = () => bufAB64u(crypto.getRandomValues(new Uint8Array(15)));
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

const VISTAS = ['vInicio', 'vEspera', 'vResultado', 'vError'];
function ver(v) { VISTAS.forEach((x) => $(x).classList.toggle('oculto', x !== v)); }
function boton(texto, activo = true, girando = false) {
  const b = $('bAccion');
  if (!texto) { b.hidden = true; return; }
  b.hidden = false; $('bTexto').textContent = texto; b.disabled = !activo;
  $('spin').classList.toggle('oculto', !girando);
}
function avisar(t) { $('aviso').textContent = t || ''; $('aviso').classList.toggle('oculto', !t); }
function error(titulo, texto) { ver('vError'); $('eTitulo').textContent = titulo; $('eTexto').textContent = texto; boton(null); }

function mensajeError(e) {
  if (e && e.name === 'NotAllowedError') return ES_ALTA
    ? 'Se canceló el registro. Toca el botón otra vez y pon tu huella.'
    : 'Se canceló o no se reconoció la huella. Si no has registrado este celular, pide al encargado que lo registre en el checador.';
  if (e && e.name === 'InvalidStateError') return 'Este celular ya estaba registrado.';
  if (e && e.name === 'SecurityError') return 'Abre este enlace en Chrome (Android) o Safari (iPhone), no dentro de otra app.';
  return (e && e.message) || 'Algo salió mal. Intenta de nuevo.';
}

function reloj() {
  const d = new Date();
  $('reloj').textContent = d.toLocaleTimeString('es-MX', { hour: 'numeric', minute: '2-digit' });
  const f = d.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' });
  $('fecha').textContent = f.charAt(0).toUpperCase() + f.slice(1);
}

// ---------- comunicación con el kiosco (vía Apps Script)
async function enviar(tipo, payload) {
  const id = idAleatorio();
  const r = await fetch(RELAY, { method: 'POST', body: JSON.stringify({ accion: 'relay', k: P.k, tipo, id, payload }) });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'No se pudo enviar');
  return id;
}

async function esperarResultado(id, segundos = 30) {
  const fin = Date.now() + segundos * 1000;
  while (Date.now() < fin) {
    await dormir(1500);
    try {
      const r = await fetch(RELAY + '?accion=resultado&id=' + encodeURIComponent(id));
      const j = await r.json();
      if (j.ok && j.listo) return j;
    } catch (e) { /* reintenta */ }
  }
  return null;
}

// Manda la huella al checador (vía Apps Script) y espera su respuesta
async function entregar(tipo, payload, alListo) {
  ver('vEspera'); boton(null);
  $('esperaTitulo').textContent = 'Enviando…';
  $('esperaTexto').textContent = 'Mira el checador.';
  let id;
  try { id = await enviar(tipo, payload); }
  catch (e) {
    return error('Sin conexión', 'Conéctate al WiFi de la empresa y vuelve a escanear el QR del checador.');
  }
  $('esperaTitulo').textContent = 'Esperando al checador…';
  const r = await esperarResultado(id);
  if (!r) return error('El checador no respondió',
    'Revisa que el checador esté encendido y con internet, y vuelve a escanear su QR. Si sigue igual, avisa al encargado.');
  if (!r.exito) return error('No se pudo', r.mensaje || 'Intenta de nuevo.');
  alListo(r);
}

// ---------- CHECAR
function iniciarChecar() {
  const pista = leer('chk_cred');
  if (pista && pista.nombre) $('saludo').textContent = 'Hola, ' + pista.nombre.split(' ')[0];
  $('instruccion').textContent = 'Toca el botón y pon tu huella para registrar tu checada.';
  $('marca').textContent = 'Checador Packatelas · ' + P.k;
  ver('vInicio'); boton('Checar con huella');
  $('bAccion').onclick = async () => {
    avisar('');
    const opciones = {
      challenge: b64uABuf(P.c), rpId: location.hostname, userVerification: 'required', timeout: 90000,
      allowCredentials: pista && pista.id ? [{ type: 'public-key', id: b64uABuf(pista.id) }] : [],
    };
    boton('Pon tu huella…', false, true);
    let cred;
    try { cred = await navigator.credentials.get({ publicKey: opciones }); }
    catch (e) { avisar(mensajeError(e)); boton('Intentar de nuevo'); return; }
    const r = cred.response;
    const payload = ['PKC1', bufAB64u(cred.rawId), bufAB64u(r.clientDataJSON), bufAB64u(r.authenticatorData), bufAB64u(r.signature)].join('.');
    if (navigator.vibrate) navigator.vibrate(60);
    await entregar('checar', payload, (res) => {
      guardar('chk_cred', { id: bufAB64u(cred.rawId), nombre: res.nombre });
      const vr = $('vResultado');
      vr.classList.remove('entrada', 'salida'); vr.classList.add(/^(ENTRADA|REGRESO)/.test(res.tipo) ? 'entrada' : 'salida');
      $('rTipo').textContent = res.tipo; $('rTipo').style.fontSize = res.tipo.length > 10 ? '38px' : ''; $('rNombre').textContent = res.nombre; $('rHora').textContent = res.hora || '';
      ver('vResultado'); $('pie').textContent = 'Ya puedes cerrar esta página.';
      if (navigator.vibrate) navigator.vibrate(150);
    });
  };
}

// ---------- ALTA (registrar este celular)
function iniciarAlta() {
  const nombre = P.n || '';
  $('saludo').textContent = 'Hola, ' + nombre;
  $('reloj').classList.add('oculto'); $('fecha').classList.add('oculto');
  $('instruccion').innerHTML = 'Vamos a registrar <b>este celular</b> para que puedas checar con tu huella. Solo se hace una vez.';
  ver('vInicio'); boton('Registrar mi huella');
  $('bAccion').onclick = async () => {
    avisar('');
    const opciones = {
      challenge: b64uABuf(P.c),
      rp: { id: location.hostname, name: 'Packatelas Checador' },
      user: { id: new TextEncoder().encode('emp-' + (P.u || '')), name: nombre + ' (' + (P.u || '') + ')', displayName: nombre },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
      attestation: 'none', timeout: 120000,
    };
    boton('Pon tu huella…', false, true);
    let cred;
    try { cred = await navigator.credentials.create({ publicKey: opciones }); }
    catch (e) { avisar(mensajeError(e)); boton('Intentar de nuevo'); return; }
    const payload = ['PKA1', bufAB64u(cred.response.clientDataJSON), bufAB64u(cred.response.attestationObject)].join('.');
    await entregar('alta', payload, (res) => {
      guardar('chk_cred', { id: bufAB64u(cred.rawId), nombre: res.nombre || nombre });
      const vr = $('vResultado'); vr.classList.add('entrada');
      $('rTipo').textContent = '¡Listo!'; $('rNombre').textContent = res.nombre || nombre;
      $('rHora').textContent = 'Celular registrado. Para checar, escanea el QR del checador y pon tu huella.';
      ver('vResultado'); $('pie').textContent = 'Ya puedes cerrar esta página.';
    });
  };
}

// ---------- arranque
(async () => {
  reloj(); setInterval(reloj, 1000);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
  if (!P.k || !P.c || !P.s) {
    return error('Escanea el QR del checador', 'Abre la cámara de tu celular y apunta al QR que aparece en el checador de la base.');
  }
  if (!window.PublicKeyCredential || !navigator.credentials) {
    return error('Navegador no compatible', 'Abre este enlace en Chrome (Android) o Safari (iPhone). Si lo abriste desde otra app, usa "Abrir en el navegador".');
  }
  try {
    if (PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable &&
        !(await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable())) {
      return error('Configura tu huella', 'Tu celular no tiene huella o bloqueo de pantalla. Actívalo en Ajustes y vuelve a escanear el QR.');
    }
  } catch (e) { /* algunos navegadores no lo implementan */ }
  if (ES_ALTA) iniciarAlta(); else iniciarChecar();
})();

// El QR cambia: si vuelven a escanear con la página abierta, se recarga con el nuevo reto
window.addEventListener('hashchange', () => location.reload());
