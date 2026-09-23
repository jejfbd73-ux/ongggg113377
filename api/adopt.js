module.exports = async (req, res) => {
  return res.status(410).json({ ok: false, error: 'Este formulario utiliza Basin para procesar las solicitudes.' });
};
