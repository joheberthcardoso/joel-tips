// Junta os arquivos de /cache num único historico.json (para subir no GitHub/Render).
// Rode: node gerar-historico.js
const fs = require('fs');
const path = require('path');
const VERSION = 3; // igual ao DATA_VERSION do server.js
const dir = path.join(__dirname, 'cache');
const days = {};
for (const f of fs.readdirSync(dir)) {
  const m = f.match(new RegExp(`^v${VERSION}_(\\d{8})\\.json$`));
  if (m) days[m[1]] = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
}
fs.writeFileSync(path.join(__dirname, 'historico.json'), JSON.stringify({ v: VERSION, days }));
console.log(`historico.json criado com ${Object.keys(days).length} dias.`);
