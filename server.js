const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8'
};

const server = http.createServer((req, res) => {
  let filePath = '.' + (req.url === '/' ? '/index.html' : req.url);
  let ext = path.extname(filePath);
  let contentType = mimeTypes[ext] || 'application/octet-stream';
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server });

// --- Lobbies ---
const lobbies = new Map();

function maakLobbyId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id;
  do {
    id = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');

  } while (lobbies.has(id));
  return id;
}

function maakNieuweLobby() {
  const id = maakLobbyId();
  lobbies.set(id, {
    spelers: [],
    handen: {},
    dek: [],
    stapel: [],
    beurtIndex: 0,
    gestart: false,
    extraBeurt: false,
    moetPakken: 0,
    wachtOpKleur: false,
    gekozenKleur: null,
    moetLaatsteKaartRoepen: new Set(),
    winnen: {},
    spelModus: 'pesten',
    bjGestart: false,
    bjDekBj: [],
    bjDealerHand: [],
    bjSpelerHanden: {},
    bjStatus: {},
    bjBeurtIndex: 0,
    bjFase: 'wachten',
    bjResultaten: {},
    spectators: new Set()
  });
  return id;
}

// --- Kaarten ---
function maakDek() {
  const kleuren = ['♠', '♥', '♦', '♣'];
  const waarden = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
  const dek = [];
  for (const kleur of kleuren)
    for (const waarde of waarden)
      dek.push({ kleur, waarde, id: `${waarde}${kleur}` });
  for (let i = 1; i <= 4; i++)
    dek.push({ kleur: '🃏', waarde: 'JOKER', id: `JOKER${i}` });
  return dek.sort(() => Math.random() - 0.5);
}

// --- Blackjack helpers ---
function bjKaartWaarde(kaart) {
  if (['J', 'Q', 'K'].includes(kaart.waarde)) return 10;
  if (kaart.waarde === 'A') return 11;
  return parseInt(kaart.waarde);
}

function bjHandWaarde(hand) {
  let totaal = hand.reduce((sum, k) => sum + bjKaartWaarde(k), 0);
  let assen = hand.filter(k => k.waarde === 'A').length;
  while (totaal > 21 && assen > 0) { totaal -= 10; assen--; }
  return totaal;
}

// --- Broadcast helpers ---
function broadcastToLobby(lobbyId, data) {
  const lobby = lobbies.get(lobbyId);
  if (!lobby) return;
  const msg = JSON.stringify(data);
  lobby.spelers.forEach(s => { if (s.ws.readyState === WebSocket.OPEN) s.ws.send(msg); });
  lobby.spectators.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(msg); });
}

function stuurSpelStatus(lobbyId) {
  const lobby = lobbies.get(lobbyId);
  if (!lobby) return;
  const basis = {
    type: 'spelstatus',
    stapelTop: lobby.stapel[lobby.stapel.length - 1],
    beurt: lobby.spelers[lobby.beurtIndex]?.id,
    spelers: lobby.spelers.map(s => ({
      id: s.id, naam: s.naam,
      aantalKaarten: lobby.handen[s.id]?.length,
      wins: lobby.winnen[s.naam] || 0
    })),
    extraBeurt: lobby.extraBeurt,
    dekAantal: lobby.dek.length,
    moetLaatsteKaartRoepen: [...lobby.moetLaatsteKaartRoepen],
    wachtOpKleur: lobby.wachtOpKleur,
    gekozenKleur: lobby.gekozenKleur
  };
  lobby.spelers.forEach(sp => {
    if (sp.ws.readyState === WebSocket.OPEN)
      sp.ws.send(JSON.stringify({
        ...basis,
        hand: lobby.handen[sp.id],
        moetPakken: lobby.spelers[lobby.beurtIndex]?.id === sp.id ? lobby.moetPakken : 0
      }));
  });
  lobby.spectators.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify({ ...basis, hand: null, moetPakken: lobby.moetPakken }));
  });
}

function stuurBjStatus(lobbyId) {
  const lobby = lobbies.get(lobbyId);
  if (!lobby) return;
  const zichtbaar = lobby.bjFase === 'dealer' || lobby.bjFase === 'klaar';
  const dealerHand = lobby.bjDealerHand.length > 0
    ? (zichtbaar ? lobby.bjDealerHand : [lobby.bjDealerHand[0], { verborgen: true, id: 'verborgen' }])
    : [];
  const beurtSpeler = lobby.bjFase === 'spelen' ? lobby.spelers[lobby.bjBeurtIndex]?.id : null;
  const basis = {
    type: 'bjStatus',
    fase: lobby.bjFase,
    dealerHand,
    dealerWaarde: zichtbaar ? bjHandWaarde(lobby.bjDealerHand) : null,
    beurt: beurtSpeler,
    spelers: lobby.spelers.map(s => ({
      id: s.id, naam: s.naam,
      status: lobby.bjStatus[s.id] || 'wachten',
      waarde: bjHandWaarde(lobby.bjSpelerHanden[s.id] || []),
      wins: lobby.winnen[s.naam] || 0,
      resultaat: lobby.bjResultaten[s.id] || null
    }))
  };
  lobby.spelers.forEach(sp => {
    if (sp.ws.readyState === WebSocket.OPEN)
      sp.ws.send(JSON.stringify({ ...basis, hand: lobby.bjSpelerHanden[sp.id] || [] }));
  });
  lobby.spectators.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify({ ...basis, hand: null }));
  });
}

function bjVolgendeSpeler(lobbyId) {
  const lobby = lobbies.get(lobbyId);
  for (let i = 0; i < lobby.spelers.length; i++) {
    if (lobby.bjStatus[lobby.spelers[i].id] === 'wachten') {
      lobby.bjBeurtIndex = i;
      lobby.bjStatus[lobby.spelers[i].id] = 'bezig';
      return true;
    }
  }
  return false;
}

function bjDealerFase(lobbyId) {
  const lobby = lobbies.get(lobbyId);
  lobby.bjFase = 'dealer';
  stuurBjStatus(lobbyId);
  while (bjHandWaarde(lobby.bjDealerHand) < 17 && lobby.bjDekBj.length > 0)
    lobby.bjDealerHand.push(lobby.bjDekBj.pop());
  const dealerWaarde = bjHandWaarde(lobby.bjDealerHand);
  const dealerBj = dealerWaarde === 21 && lobby.bjDealerHand.length === 2;
  lobby.spelers.forEach(sp => {
    const spWaarde = bjHandWaarde(lobby.bjSpelerHanden[sp.id] || []);
    const st = lobby.bjStatus[sp.id];
    if (st === 'gebust') {
      lobby.bjResultaten[sp.id] = 'verloren';
    } else if (st === 'blackjack') {
      lobby.bjResultaten[sp.id] = dealerBj ? 'gelijkspel' : 'blackjack';
      if (!dealerBj) lobby.winnen[sp.naam] = (lobby.winnen[sp.naam] || 0) + 1;
    } else if (dealerWaarde > 21 || spWaarde > dealerWaarde) {
      lobby.bjResultaten[sp.id] = 'gewonnen';
      lobby.winnen[sp.naam] = (lobby.winnen[sp.naam] || 0) + 1;
    } else if (spWaarde === dealerWaarde) {
      lobby.bjResultaten[sp.id] = 'gelijkspel';
    } else {
      lobby.bjResultaten[sp.id] = 'verloren';
    }
  });
  lobby.bjFase = 'klaar';
  lobby.bjGestart = false;
  stuurBjStatus(lobbyId);
}

function kaartMagGespeeld(kaart, top, gekozenKleur) {
  if (kaart.waarde === 'JOKER') return true;
  if (top.waarde === 'JOKER') return true;
  const effectieveKleur = gekozenKleur || top.kleur;
  return kaart.kleur === effectieveKleur || kaart.waarde === top.waarde;
}

// --- WebSocket verbindingen ---
wss.on('connection', (ws) => {
  const id = Date.now().toString() + Math.random().toString(36).slice(2, 6);
  let lobbyId = null;
  let isSpectator = false;

  ws.on('message', (msg) => {
    const data = JSON.parse(msg);

    // Lobby aanmaken of joinen
    if (data.type === 'maakLobby') {
      lobbyId = maakNieuweLobby();
      ws.send(JSON.stringify({ type: 'lobbyAangemaakt', lobbyId }));
      return;
    }

    if (data.type === 'joinLobby') {
      const lid = (data.lobbyId || '').toUpperCase().trim();
      if (!lobbies.has(lid)) {
        ws.send(JSON.stringify({ type: 'fout', bericht: `Lobby "${lid}" bestaat niet` }));
        return;
      }
      lobbyId = lid;
      ws.send(JSON.stringify({ type: 'lobbyGejoint', lobbyId }));
      ws.send(JSON.stringify({ type: 'modusGekozen', modus: lobbies.get(lobbyId).spelModus }));
      return;
    }

    if (!lobbyId) {
      ws.send(JSON.stringify({ type: 'fout', bericht: 'Kies eerst een lobby' }));
      return;
    }

    const lobby = lobbies.get(lobbyId);
    if (!lobby) {
      ws.send(JSON.stringify({ type: 'fout', bericht: 'Lobby niet gevonden' }));
      return;
    }

    if (data.type === 'joinSpectator') {
      isSpectator = true;
      lobby.spectators.add(ws);
      ws.send(JSON.stringify({ type: 'wachtkamer', spelers: lobby.spelers.map(s => s.naam) }));
      ws.send(JSON.stringify({ type: 'modusGekozen', modus: lobby.spelModus }));
      if (lobby.spelModus === 'pesten' && lobby.gestart) {
        ws.send(JSON.stringify({
          type: 'spelstatus',
          stapelTop: lobby.stapel[lobby.stapel.length - 1],
          beurt: lobby.spelers[lobby.beurtIndex]?.id,
          spelers: lobby.spelers.map(s => ({ id: s.id, naam: s.naam, aantalKaarten: lobby.handen[s.id]?.length, wins: lobby.winnen[s.naam] || 0 })),
          extraBeurt: lobby.extraBeurt,
          moetPakken: lobby.moetPakken,
          dekAantal: lobby.dek.length,
          hand: null,
          moetLaatsteKaartRoepen: [...lobby.moetLaatsteKaartRoepen]
        }));
      } else if (lobby.spelModus === 'blackjack' && (lobby.bjGestart || lobby.bjFase === 'klaar')) {
        stuurBjStatus(lobbyId);
      }
      return;
    }

    if (data.type === 'join') {
      if (lobby.gestart || (lobby.bjGestart && lobby.bjFase === 'spelen')) {
        ws.send(JSON.stringify({ type: 'fout', bericht: 'Spel al gestart' })); return;
      }
      lobby.spelers.push({ id, naam: data.naam, ws });
      lobby.handen[id] = [];
      broadcastToLobby(lobbyId, { type: 'wachtkamer', spelers: lobby.spelers.map(s => s.naam) });
      ws.send(JSON.stringify({ type: 'jouwId', id }));
      return;
    }

    if (data.type === 'kiesModus') {
      if (lobby.gestart || (lobby.bjGestart && lobby.bjFase === 'spelen')) return;
      lobby.spelModus = data.modus === 'blackjack' ? 'blackjack' : 'pesten';
      broadcastToLobby(lobbyId, { type: 'modusGekozen', modus: lobby.spelModus });
      return;
    }

    if (data.type === 'start') {
      if (lobby.spelModus === 'blackjack') {
        if (lobby.spelers.length < 1) { ws.send(JSON.stringify({ type: 'fout', bericht: 'Minimaal 1 speler nodig' })); return; }
        lobby.bjGestart = true;
        lobby.bjFase = 'spelen';
        lobby.bjDekBj = maakDek().filter(k => k.waarde !== 'JOKER').sort(() => Math.random() - 0.5);
        lobby.bjDealerHand = [];
        lobby.bjSpelerHanden = {};
        lobby.bjStatus = {};
        lobby.bjResultaten = {};
        lobby.bjBeurtIndex = 0;
        lobby.spelers.forEach(sp => {
          lobby.bjSpelerHanden[sp.id] = [lobby.bjDekBj.pop(), lobby.bjDekBj.pop()];
          lobby.bjStatus[sp.id] = bjHandWaarde(lobby.bjSpelerHanden[sp.id]) === 21 ? 'blackjack' : 'wachten';
        });
        lobby.bjDealerHand = [lobby.bjDekBj.pop(), lobby.bjDekBj.pop()];
        if (!bjVolgendeSpeler(lobbyId)) { bjDealerFase(lobbyId); return; }
        stuurBjStatus(lobbyId);
        return;
      }
      if (lobby.spelers.length < 2) { ws.send(JSON.stringify({ type: 'fout', bericht: 'Minimaal 2 spelers nodig' })); return; }
      lobby.gestart = true;
      lobby.dek = maakDek();
      lobby.spelers.forEach(sp => { lobby.handen[sp.id] = lobby.dek.splice(0, 7); });
      lobby.stapel.push(lobby.dek.splice(0, 1)[0]);
      lobby.extraBeurt = false;
      lobby.moetPakken = 0;
      lobby.wachtOpKleur = false;
      lobby.gekozenKleur = null;
      lobby.moetLaatsteKaartRoepen = new Set();
      lobby.beurtIndex = 0;
      stuurSpelStatus(lobbyId);
      return;
    }

    if (data.type === 'bjHit') {
      if (!lobby.bjGestart || lobby.bjFase !== 'spelen') return;
      if (lobby.spelers[lobby.bjBeurtIndex]?.id !== id) return;
      if (lobby.bjStatus[id] !== 'bezig') return;
      lobby.bjSpelerHanden[id].push(lobby.bjDekBj.pop());
      const waarde = bjHandWaarde(lobby.bjSpelerHanden[id]);
      if (waarde > 21) {
        lobby.bjStatus[id] = 'gebust';
        if (!bjVolgendeSpeler(lobbyId)) { bjDealerFase(lobbyId); return; }
      } else if (waarde === 21) {
        lobby.bjStatus[id] = 'gepast';
        if (!bjVolgendeSpeler(lobbyId)) { bjDealerFase(lobbyId); return; }
      }
      stuurBjStatus(lobbyId);
      return;
    }

    if (data.type === 'bjStand') {
      if (!lobby.bjGestart || lobby.bjFase !== 'spelen') return;
      if (lobby.spelers[lobby.bjBeurtIndex]?.id !== id) return;
      if (lobby.bjStatus[id] !== 'bezig') return;
      lobby.bjStatus[id] = 'gepast';
      if (!bjVolgendeSpeler(lobbyId)) { bjDealerFase(lobbyId); return; }
      stuurBjStatus(lobbyId);
      return;
    }

    if (data.type === 'speelKaart') {
      const speler = lobby.spelers.find(s => s.id === id);
      if (!speler || lobby.spelers[lobby.beurtIndex].id !== id) return;

      const kaart = lobby.handen[id].find(k => k.id === data.kaartId);
      const top = lobby.stapel[lobby.stapel.length - 1];

      if (lobby.moetPakken > 0) {
        const kanStapelen = kaart && (kaart.waarde === '2' || kaart.waarde === 'JOKER') && kaartMagGespeeld(kaart, top, lobby.gekozenKleur);
        if (!kanStapelen) {
          ws.send(JSON.stringify({ type: 'fout', bericht: 'Je moet kaarten pakken, een 2 opleggen of een joker opleggen!' }));
          return;
        }
      } else if (!kaart || !kaartMagGespeeld(kaart, top, lobby.gekozenKleur)) {
        ws.send(JSON.stringify({ type: 'fout', bericht: 'Deze kaart mag je niet spelen!' }));
        return;
      }

      lobby.handen[id] = lobby.handen[id].filter(k => k.id !== data.kaartId);
      lobby.stapel.push(kaart);
      lobby.gekozenKleur = null;

      if (lobby.handen[id].length === 1) {
        lobby.moetLaatsteKaartRoepen.add(id);
      }

      if (lobby.handen[id].length === 0) {
        lobby.winnen[speler.naam] = (lobby.winnen[speler.naam] || 0) + 1;
        broadcastToLobby(lobbyId, { type: 'gewonnen', naam: speler.naam, wins: lobby.winnen[speler.naam] });
        lobby.gestart = false;
        lobby.wachtOpKleur = false;
        lobby.gekozenKleur = null;
        lobby.moetLaatsteKaartRoepen = new Set();
        lobby.spelers = []; lobby.handen = {}; lobby.dek = []; lobby.stapel = [];
        return;
      }

      if (kaart.waarde === 'JOKER') {
        lobby.moetPakken += 5;
        lobby.beurtIndex = (lobby.beurtIndex + 1) % lobby.spelers.length;
      } else if (kaart.waarde === '2') {
        lobby.moetPakken += 2;
        lobby.beurtIndex = (lobby.beurtIndex + 1) % lobby.spelers.length;
      } else if (kaart.waarde === '7') {
        lobby.extraBeurt = true;
      } else if (kaart.waarde === '8') {
        lobby.beurtIndex = (lobby.beurtIndex + 2) % lobby.spelers.length;
      } else if (kaart.waarde === 'A') {
        lobby.beurtIndex = (lobby.beurtIndex + 2) % lobby.spelers.length;
      } else if (kaart.waarde === 'J') {
        lobby.extraBeurt = false;
        lobby.wachtOpKleur = true;
        stuurSpelStatus(lobbyId);
        return;
      } else {
        lobby.beurtIndex = (lobby.beurtIndex + 1) % lobby.spelers.length;
      }

      stuurSpelStatus(lobbyId);
      return;
    }

    if (data.type === 'kiesKleur') {
      if (!lobby.wachtOpKleur) return;
      if (lobby.spelers[lobby.beurtIndex]?.id !== id) return;
      const geldigeKleuren = ['♠', '♥', '♦', '♣'];
      if (!geldigeKleuren.includes(data.kleur)) return;
      lobby.gekozenKleur = data.kleur;
      lobby.wachtOpKleur = false;
      lobby.beurtIndex = (lobby.beurtIndex + 1) % lobby.spelers.length;
      stuurSpelStatus(lobbyId);
      return;
    }

    if (data.type === 'pakKaart') {
      if (lobby.wachtOpKleur) return;
      if (lobby.spelers[lobby.beurtIndex]?.id !== id) return;
      lobby.extraBeurt = false;
      lobby.moetLaatsteKaartRoepen.delete(id);
      if (lobby.dek.length === 0) {
        const top = lobby.stapel.pop();
        lobby.dek = lobby.stapel.sort(() => Math.random() - 0.5);
        lobby.stapel = [top];
      }
      if (lobby.moetPakken > 0) {
        lobby.handen[id].push(...lobby.dek.splice(0, lobby.moetPakken));
        lobby.moetPakken = 0;
      } else {
        lobby.handen[id].push(lobby.dek.splice(0, 1)[0]);
      }
      lobby.beurtIndex = (lobby.beurtIndex + 1) % lobby.spelers.length;
      stuurSpelStatus(lobbyId);
      return;
    }

    if (data.type === 'chat') {
      const naam = lobby.spelers.find(s => s.id === id)?.naam || (isSpectator ? 'Kijker' : null);
      if (!naam) return;
      const bericht = String(data.bericht || '').slice(0, 120).trim();
      if (!bericht) return;
      broadcastToLobby(lobbyId, { type: 'chat', naam, bericht });
      return;
    }

    if (data.type === 'laatsTeKaart') {
      if (!lobby.moetLaatsteKaartRoepen.has(id)) return;
      lobby.moetLaatsteKaartRoepen.delete(id);
      const naam = lobby.spelers.find(s => s.id === id)?.naam || 'Onbekend';
      broadcastToLobby(lobbyId, { type: 'laatsTeKaartAangekondigd', naam });
      stuurSpelStatus(lobbyId);
      return;
    }

    if (data.type === 'vangLaatsTeKaart') {
      const doelId = data.doelId;
      if (!doelId || !lobby.moetLaatsteKaartRoepen.has(doelId)) return;
      if (lobby.handen[doelId]?.length !== 1) return;

      lobby.moetLaatsteKaartRoepen.delete(doelId);

      if (lobby.dek.length < 2) {
        const top = lobby.stapel.pop();
        lobby.dek = [...lobby.dek, ...lobby.stapel].sort(() => Math.random() - 0.5);
        lobby.stapel = [top];
      }
      lobby.handen[doelId].push(...lobby.dek.splice(0, Math.min(2, lobby.dek.length)));

      const doelNaam = lobby.spelers.find(s => s.id === doelId)?.naam || 'Onbekend';
      const vangerNaam = lobby.spelers.find(s => s.id === id)?.naam || (isSpectator ? 'Kijker' : 'Onbekend');
      broadcastToLobby(lobbyId, { type: 'gepakt', doelNaam, vangerNaam });
      stuurSpelStatus(lobbyId);
      return;
    }
  });

  ws.on('close', () => {
    if (!lobbyId) return;
    const lobby = lobbies.get(lobbyId);
    if (!lobby) return;

    if (isSpectator) {
      lobby.spectators.delete(ws);
      return;
    }

    lobby.moetLaatsteKaartRoepen.delete(id);

    if (lobby.bjGestart && lobby.bjFase === 'spelen' && lobby.spelers[lobby.bjBeurtIndex]?.id === id) {
      lobby.bjStatus[id] = 'gepast';
      lobby.spelers = lobby.spelers.filter(s => s.id !== id);
      delete lobby.bjSpelerHanden[id];
      if (lobby.spelers.length === 0 || !bjVolgendeSpeler(lobbyId)) { bjDealerFase(lobbyId); return; }
      stuurBjStatus(lobbyId);
      return;
    }

    lobby.spelers = lobby.spelers.filter(s => s.id !== id);
    delete lobby.handen[id];
    if (lobby.gestart && lobby.spelers.length < 2) {
      broadcastToLobby(lobbyId, { type: 'fout', bericht: 'Een speler heeft de verbinding verbroken' });
      lobby.gestart = false;
      lobby.moetLaatsteKaartRoepen = new Set();
    } else {
      broadcastToLobby(lobbyId, { type: 'wachtkamer', spelers: lobby.spelers.map(s => s.naam) });
    }
  });
});

server.listen(3000, () => console.log('Pesten draait op http://localhost:3000'));
