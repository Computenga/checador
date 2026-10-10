// Verificación de huellas (WebAuthn) en el navegador del kiosco, sin servidor.
// Formatos que manda el celular (todo en base64url):
//   alta:    "PKA1.<clientDataJSON>.<attestationObject>"
//   checada: "PKC1.<credId>.<clientDataJSON>.<authenticatorData>.<firma>"
'use strict';
(function (raiz) {
  const ES256 = -7, RS256 = -257;
  const UP = 0x01, UV = 0x04, AT = 0x40;
  const subtle = (raiz.crypto || require('crypto').webcrypto).subtle;

  class ErrorHuella extends Error {
    constructor(paraCelular, detalle) { super(detalle || paraCelular); this.paraCelular = paraCelular; }
  }

  // ---------- base64url
  function dec(s) {
    s = String(s).replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '=';
    const bin = atob(s), u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }
  function enc(u) {
    u = u instanceof Uint8Array ? u : new Uint8Array(u); let s = '';
    for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  // ---------- CBOR mínimo (lo que usa WebAuthn)
  function cbor(b, pos) {
    let p = pos || 0;
    const u8 = () => { if (p >= b.length) throw new Error('CBOR truncado'); return b[p++]; };
    const largo = (info) => {
      if (info < 24) return info;
      if (info === 24) return u8();
      if (info === 25) return (u8() << 8) | u8();
      if (info === 26) { let n = 0; for (let i = 0; i < 4; i++) n = n * 256 + u8(); return n; }
      if (info === 27) { let n = 0; for (let i = 0; i < 8; i++) n = n * 256 + u8(); return n; }
      throw new Error('CBOR indefinido no soportado');
    };
    const leer = () => {
      const ini = u8(), mayor = ini >> 5, info = ini & 31;
      switch (mayor) {
        case 0: return largo(info);
        case 1: return -1 - largo(info);
        case 2: { const n = largo(info); const v = b.slice(p, p + n); if (v.length !== n) throw new Error('CBOR truncado'); p += n; return v; }
        case 3: { const n = largo(info); const v = new TextDecoder().decode(b.slice(p, p + n)); p += n; return v; }
        case 4: { const n = largo(info); const a = []; for (let i = 0; i < n; i++) a.push(leer()); return a; }
        case 5: { const n = largo(info); const m = new Map(); for (let i = 0; i < n; i++) { const k = leer(); m.set(k, leer()); } return m; }
        case 6: largo(info); return leer();
        case 7: if (info === 20) return false; if (info === 21) return true; if (info === 22 || info === 23) return null;
          throw new Error('CBOR simple no soportado');
      }
    };
    const v = leer();
    return { v, pos: p };
  }

  const sha256 = async (u8) => new Uint8Array(await subtle.digest('SHA-256', u8));
  const iguales = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

  // Firma ECDSA en DER -> r||s de 64 bytes (formato que pide WebCrypto)
  function derARaw(der) {
    let p = 0;
    if (der[p++] !== 0x30) throw new Error('firma no DER');
    let len = der[p++]; if (len & 0x80) p += len & 0x7f;
    const entero = () => {
      if (der[p++] !== 0x02) throw new Error('firma no DER');
      const n = der[p++]; let v = der.slice(p, p + n); p += n;
      while (v.length > 32 && v[0] === 0) v = v.slice(1);
      if (v.length > 32) throw new Error('firma inválida');
      const out = new Uint8Array(32); out.set(v, 32 - v.length); return out;
    };
    const r = entero(), s = entero(), raw = new Uint8Array(64);
    raw.set(r, 0); raw.set(s, 32); return raw;
  }

  function partes(payload, prefijo, n) {
    const p = String(payload || '').trim().split('.');
    if (p.length !== n || p[0] !== prefijo) throw new ErrorHuella('Código no reconocido. Intenta de nuevo.', 'formato');
    return p.slice(1);
  }

  function clientData(cdB64, tipo, op) {
    const cd = dec(cdB64);
    let j;
    try { j = JSON.parse(new TextDecoder().decode(cd)); } catch (e) { throw new ErrorHuella('Datos dañados. Intenta de nuevo.', 'clientDataJSON'); }
    if (j.type !== tipo) throw new ErrorHuella('Datos dañados. Intenta de nuevo.', 'type=' + j.type);
    if (j.origin !== op.origen) throw new ErrorHuella('Esta página no corresponde al checador.', 'origin=' + j.origin);
    if (j.crossOrigin === true) throw new ErrorHuella('Abre la página directamente, no dentro de otra.');
    if (!op.retoValido(j.challenge)) throw new ErrorHuella('El QR ya venció. Escanea de nuevo el QR del checador.', 'reto');
    return cd;
  }

  async function datosAut(ad, op, conLlave) {
    if (ad.length < 37) throw new ErrorHuella('Datos dañados. Intenta de nuevo.', 'authData corto');
    const h = await sha256(new TextEncoder().encode(op.rpId));
    if (!iguales(ad.slice(0, 32), h)) throw new ErrorHuella('Esta página no corresponde al checador.', 'rpIdHash');
    const flags = ad[32];
    if (!(flags & UP)) throw new ErrorHuella('No se confirmó la presencia. Intenta de nuevo.');
    if (!(flags & UV)) throw new ErrorHuella('Tu celular no pidió huella ni bloqueo. Activa la huella en Ajustes.');
    const contador = ((ad[33] << 24) >>> 0) + (ad[34] << 16) + (ad[35] << 8) + ad[36];
    if (!conLlave) return { contador };
    if (!(flags & AT)) throw new ErrorHuella('Datos dañados. Intenta de nuevo.', 'sin AT');
    let p = 37 + 16;
    const n = (ad[p] << 8) | ad[p + 1]; p += 2;
    const credId = ad.slice(p, p + n); p += n;
    const cose = cbor(ad, p).v;
    return { contador, credId, cose };
  }

  function jwkDeCose(m) {
    const kty = m.get(1), alg = m.get(3);
    if (kty === 2 && alg === ES256 && m.get(-1) === 1) {
      return { alg: ES256, jwk: { kty: 'EC', crv: 'P-256', x: enc(m.get(-2)), y: enc(m.get(-3)), ext: true } };
    }
    if (kty === 3 && alg === RS256) {
      return { alg: RS256, jwk: { kty: 'RSA', n: enc(m.get(-1)), e: enc(m.get(-2)), alg: 'RS256', ext: true } };
    }
    throw new ErrorHuella('Tipo de llave no soportado.', 'kty=' + kty + ' alg=' + alg);
  }

  const importar = (jwk, alg) => alg === RS256
    ? subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
    : subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);

  /** op = { origen, rpId, retoValido(reto) } -> { id, jwk, alg, contador } */
  async function verificarAlta(payload, op) {
    const [cdB, aoB] = partes(payload, 'PKA1', 3);
    clientData(cdB, 'webauthn.create', op);
    let ao;
    try { ao = cbor(dec(aoB)).v; } catch (e) { throw new ErrorHuella('Datos dañados.', 'attestationObject'); }
    const ad = ao instanceof Map ? ao.get('authData') : null;
    if (!ad) throw new ErrorHuella('Datos dañados.', 'sin authData');
    const d = await datosAut(ad, op, true);
    const { jwk, alg } = jwkDeCose(d.cose);
    await importar(jwk, alg);   // confirma que la llave es válida
    return { id: enc(d.credId), jwk, alg, contador: d.contador };
  }

  const credIdDe = (payload) => partes(payload, 'PKC1', 5)[0];

  /** cred = { id, jwk, alg, contador } -> nuevo contador */
  async function verificarChecada(payload, cred, op) {
    const [idB, cdB, adB, sgB] = partes(payload, 'PKC1', 5);
    if (idB !== cred.id) throw new ErrorHuella('Este celular no está registrado.', 'credId distinto');
    const cd = clientData(cdB, 'webauthn.get', op);
    const ad = dec(adB);
    const d = await datosAut(ad, op, false);
    const datos = new Uint8Array(ad.length + 32);
    datos.set(ad, 0); datos.set(await sha256(cd), ad.length);
    const llave = await importar(cred.jwk, cred.alg);
    let ok = false;
    try {
      ok = cred.alg === RS256
        ? await subtle.verify('RSASSA-PKCS1-v1_5', llave, dec(sgB), datos)
        : await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, llave, derARaw(dec(sgB)), datos);
    } catch (e) { ok = false; }
    if (!ok) throw new ErrorHuella('No se pudo validar tu huella. Intenta de nuevo.', 'firma inválida');
    const prev = Number(cred.contador || 0);
    if ((d.contador !== 0 || prev !== 0) && d.contador <= prev) {
      throw new ErrorHuella('Se detectó una copia del registro. Avisa al encargado.', 'contador ' + d.contador + ' <= ' + prev);
    }
    return d.contador;
  }

  /** Llave guardada por la app Android (SPKI base64url) -> JWK, para importar respaldos. */
  async function jwkDeSpki(spkiB64u, alg) {
    const params = alg === RS256 ? { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } : { name: 'ECDSA', namedCurve: 'P-256' };
    const k = await subtle.importKey('spki', dec(spkiB64u), params, true, ['verify']);
    const jwk = await subtle.exportKey('jwk', k);
    delete jwk.key_ops;
    return jwk;
  }

  const api = { ErrorHuella, verificarAlta, verificarChecada, credIdDe, jwkDeSpki, b64u: { dec, enc }, cbor, ES256, RS256 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else raiz.Verif = api;
})(typeof window !== 'undefined' ? window : globalThis);
