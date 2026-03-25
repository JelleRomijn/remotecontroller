const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const server = http.createServer((req, res) => {
  let filePath = '.' + (req.url === '/' ? '/index.html' : req.url);
  let ext = path.extname(filePath);
  let contentType = ext === '.js' ? 'application/javascript' : 'text/html';
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server });

// --- Kaarten aanmaken ---
function maakDek() {
  const kleuren = ['♠', '♥', '♦', '♣'];
  const waarden = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
  const dek = [];
  for (const kleur of kleuren)
    for (const waarde of waarden)
      dek.push({ kleur, waarde, id: `${waarde}${kleur}` });
  return dek.sort(() => Math.random() - 0.5);
}

// --- Spelstatus ---
let spelers = [];
let handen = {};
let dek = [];
let stapel = [];
let beurtIndex = 0;
let gestart = false;
let extraBeurt = false;
let moetPakken = 0;

function broadcast(data) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN)
      client.send(JSON.stringify(data));
  });
}

function stuurSpelStatus() {
  // Bouw de gedeelde (publieke) speldata
  const basis = {
    type: 'spelstatus',
    stapelTop: stapel[stapel.length - 1],
    beurt: spelers[beurtIndex]?.id,
    spelers: spelers.map(s => ({ id: s.id, naam: s.naam, aantalKaarten: handen[s.id]?.length })),
    extraBeurt,
    dekAantal: dek.length
  };

  // Speler-WebSockets voor snelle lookup
  const spelerWsSet = new Set(spelers.map(s => s.ws));

  // Elke speler krijgt zijn eigen hand + persoonlijk moetPakken
  spelers.forEach(sp => {
    if (sp.ws.readyState === WebSocket.OPEN) {
      sp.ws.send(JSON.stringify({
        ...basis,
        hand: handen[sp.id],
        moetPakken: spelers[beurtIndex]?.id === sp.id ? moetPakken : 0
      }));
    }
  });

  // Alle andere verbonden clients (kijkscherm) krijgen publieke data
  wss.clients.forEach(client => {
    if (!spelerWsSet.has(client) && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({
        ...basis,
        hand: null,
        moetPakken
      }));
    }
  });
}

function volgendeBeurt(stappen = 1) {
  beurtIndex = (beurtIndex + stappen) % spelers.length;
}

function kaartMagGespeeld(kaart, top) {
  return kaart.kleur === top.kleur || kaart.waarde === top.waarde;
}

wss.on('connection', (ws) => {
  const id = Date.now().toString();
  let isSpectator = false;

  ws.on('message', (msg) => {
    const data = JSON.parse(msg);

    if (data.type === 'joinSpectator') {
      isSpectator = true;
      ws.send(JSON.stringify({ type: 'wachtkamer', spelers: spelers.map(s => s.naam) }));
      // Stuur direct huidige spelstatus als het spel al loopt
      if (gestart) {
        ws.send(JSON.stringify({
          type: 'spelstatus',
          stapelTop: stapel[stapel.length - 1],
          beurt: spelers[beurtIndex]?.id,
          spelers: spelers.map(s => ({ id: s.id, naam: s.naam, aantalKaarten: handen[s.id]?.length })),
          extraBeurt,
          moetPakken,
          dekAantal: dek.length,
          hand: null
        }));
      }
    }

    if (data.type === 'join') {
      if (gestart) { ws.send(JSON.stringify({ type: 'fout', bericht: 'Spel al gestart' })); return; }
      spelers.push({ id, naam: data.naam, ws });
      handen[id] = [];
      broadcast({ type: 'wachtkamer', spelers: spelers.map(s => s.naam) });
      ws.send(JSON.stringify({ type: 'jouwId', id }));
    }

    if (data.type === 'start') {
      if (spelers.length < 2) { ws.send(JSON.stringify({ type: 'fout', bericht: 'Minimaal 2 spelers nodig' })); return; }
      gestart = true;
      dek = maakDek();
      spelers.forEach(sp => { handen[sp.id] = dek.splice(0, 7); });
      stapel.push(dek.splice(0, 1)[0]);
      extraBeurt = false;
      moetPakken = 0;
      beurtIndex = 0;
      stuurSpelStatus();
    }

    if (data.type === 'speelKaart') {
      const speler = spelers.find(s => s.id === id);
      if (!speler || spelers[beurtIndex].id !== id) return;

      const kaart = handen[id].find(k => k.id === data.kaartId);
      const top = stapel[stapel.length - 1];

      if (moetPakken > 0) {
        if (!kaart || kaart.waarde !== '2' || !kaartMagGespeeld(kaart, top)) {
          ws.send(JSON.stringify({ type: 'fout', bericht: 'Je moet kaarten pakken of een 2 opleggen!' }));
          return;
        }
      } else if (!kaart || !kaartMagGespeeld(kaart, top)) {
        ws.send(JSON.stringify({ type: 'fout', bericht: 'Deze kaart mag je niet spelen!' }));
        return;
      }

      handen[id] = handen[id].filter(k => k.id !== data.kaartId);
      stapel.push(kaart);

      if (handen[id].length === 0) {
        broadcast({ type: 'gewonnen', naam: speler.naam });
        gestart = false;
        spelers = []; handen = {}; dek = []; stapel = [];
        return;
      }

      if (kaart.waarde === '2') {
        moetPakken += 2;
        volgendeBeurt(1);
      } else if (kaart.waarde === '7') {
        extraBeurt = true;
      } else if (kaart.waarde === '8') {
        volgendeBeurt(2);
      } else if (kaart.waarde === 'A') {
        volgendeBeurt(2);
      } else {
        volgendeBeurt();
      }

      stuurSpelStatus();
    }

    if (data.type === 'pakKaart') {
      if (spelers[beurtIndex]?.id !== id) return;
      extraBeurt = false;
      if (dek.length === 0) {
        const top = stapel.pop();
        dek = stapel.sort(() => Math.random() - 0.5);
        stapel = [top];
      }
      if (moetPakken > 0) {
        handen[id].push(...dek.splice(0, moetPakken));
        moetPakken = 0;
      } else {
        handen[id].push(dek.splice(0, 1)[0]);
      }
      volgendeBeurt();
      stuurSpelStatus();
    }
  });

  ws.on('close', () => {
    if (isSpectator) return;
    spelers = spelers.filter(s => s.id !== id);
    delete handen[id];
    if (gestart && spelers.length < 2) {
      broadcast({ type: 'fout', bericht: 'Een speler heeft de verbinding verbroken' });
      gestart = false;
    } else {
      broadcast({ type: 'wachtkamer', spelers: spelers.map(s => s.naam) });
    }
  });
});

server.listen(3000, () => console.log('Pesten draait op http://localhost:3000'));
