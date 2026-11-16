/home/user/work/probe.js
module.exports = async function (req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, probe: 'emails-v48', method: req.method, url: req.url }));
};
