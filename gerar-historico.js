// Junta os arquivos de /cache num único historico.json (para subir no GitHub/Render).
// Rode: node gerar-historico.js
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, 'cache');
const out = {};
for (const f of fs.readdirSync(dir)) {
  const m = f.match(/^all_(\d{8})\.json$/);
  if (m) out[m[1]] = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
}
fs.writeFileSync(path.join(__dirname, 'historico.json'), JSON.stringify(out));
console.log(`historico.json criado com ${Object.keys(out).length} dias.`);
