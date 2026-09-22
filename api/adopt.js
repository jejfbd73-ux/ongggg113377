const Busboy = require('busboy');

const FORM_SUBMIT_URL = 'https://formsubmit.co/fedeiribarria@gmail.com';
const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const fields = {};
    const files = [];
    let totalBytes = 0;
    let aborted = false;
    const bb = Busboy({
      headers: req.headers,
      limits: { fieldSize: 100000, fileSize: 8 * 1024 * 1024, files: 10, fields: 100 }
    });

    bb.on('field', (name, value) => { fields[name] = value; });
    bb.on('file', (name, stream, info) => {
      const chunks = [];
      let size = 0;
      stream.on('data', chunk => { size += chunk.length; totalBytes += chunk.length; chunks.push(chunk); });
      stream.on('limit', () => { aborted = true; stream.resume(); });
      stream.on('end', () => {
        if (size > 0) files.push({ name, filename: info.filename, mimeType: info.mimeType || 'application/octet-stream', buffer: Buffer.concat(chunks) });
      });
    });
    bb.on('error', reject);
    bb.on('finish', () => {
      if (aborted || totalBytes > 10 * 1024 * 1024) return reject(new Error('Archivo demasiado grande.'));
      resolve({ fields, files });
    });
    req.pipe(bb);
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Método no permitido.' });
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return res.status(500).json({ ok: false, error: 'Falta configurar la clave secreta de Turnstile en Vercel.' });

  try {
    const { fields, files } = await parseMultipart(req);
    if (fields._honey) return res.status(400).json({ ok: false, error: 'Solicitud rechazada.' });

    const token = fields['cf-turnstile-response'];
    if (!token) return res.status(400).json({ ok: false, error: 'Completá la verificación de seguridad.' });

    const verifyBody = new URLSearchParams();
    verifyBody.set('secret', secret);
    verifyBody.set('response', token);
    const forwardedFor = req.headers['x-forwarded-for'];
    if (forwardedFor) verifyBody.set('remoteip', String(forwardedFor).split(',')[0].trim());

    const verifyResponse = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: verifyBody.toString()
    });
    const verification = await verifyResponse.json();
    if (!verification.success) return res.status(403).json({ ok: false, error: 'La verificación de seguridad no fue válida. Recargá la página e intentá nuevamente.' });

    const outgoing = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      if (key === 'cf-turnstile-response') continue;
      outgoing.append(key, value);
    }
    for (const file of files) {
      outgoing.append(file.name, new Blob([file.buffer], { type: file.mimeType }), file.filename);
    }

    const forward = await fetch(FORM_SUBMIT_URL, { method: 'POST', body: outgoing, redirect: 'follow' });
    const body = await forward.text();
    if (!forward.ok) return res.status(502).send(body || 'No se pudo entregar la solicitud.');

    // No reenviamos la URL de redirección de FormSubmit: en algunos casos
    // puede venir como una ruta relativa y terminar en una URL incorrecta
    // bajo nuestro dominio. Volvemos siempre a la página de confirmación.
    return res.redirect(303, 'https://ongramallo.com/?adopcion=recibida');
  } catch (err) {
    console.error('adopt endpoint error', err);
    res.status(500).json({ ok: false, error: 'No se pudo procesar la solicitud. Intentá nuevamente.' });
  }
};
