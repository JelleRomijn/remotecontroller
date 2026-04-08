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
  for (let i = 1; i <= 4; i++)
    dek.push({ kleur: '🃏', waarde: 'JOKER', id: `JOKER${i}` });
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
let moetLaatsteKaartRoepen = new Set(); // ids van spelers met 1 kaart die nog niet geroepen hebben
let winnen = {}; // naam -> aantal gewonnen potjes (persisteert over potjes)

// --- Blackjack staat ---
let spelModus = 'pesten'; // 'pesten' | 'blackjack'
let bjGestart = false;
let bjDekBj = [];
let bjDealerHand = [];
let bjSpelerHanden = {};
let bjStatus = {}; // 'wachten' | 'bezig' | 'gepast' | 'gebust' | 'blackjack'
let bjBeurtIndex = 0;
let bjFase = 'wachten'; // 'wachten' | 'spelen' | 'dealer' | 'klaar'
let bjResultaten = {};

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

function stuurBjStatus() {
  const zichtbaar = bjFase === 'dealer' || bjFase === 'klaar';
  const dealerHand = bjDealerHand.length > 0
    ? (zichtbaar ? bjDealerHand : [bjDealerHand[0], { verborgen: true, id: 'verborgen' }])
    : [];
  const beurtSpeler = bjFase === 'spelen' ? spelers[bjBeurtIndex]?.id : null;
  const basis = {
    type: 'bjStatus',
    fase: bjFase,
    dealerHand,
    dealerWaarde: zichtbaar ? bjHandWaarde(bjDealerHand) : null,
    beurt: beurtSpeler,
    spelers: spelers.map(s => ({
      id: s.id,
      naam: s.naam,
      status: bjStatus[s.id] || 'wachten',
      waarde: bjHandWaarde(bjSpelerHanden[s.id] || []),
      wins: winnen[s.naam] || 0,
      resultaat: bjResultaten[s.id] || null
    }))
  };
  const spelerWsSet = new Set(spelers.map(s => s.ws));
  spelers.forEach(sp => {
    if (sp.ws.readyState === WebSocket.OPEN)
      sp.ws.send(JSON.stringify({ ...basis, hand: bjSpelerHanden[sp.id] || [] }));
  });
  wss.clients.forEach(client => {
    if (!spelerWsSet.has(client) && client.readyState === WebSocket.OPEN)
      client.send(JSON.stringify({ ...basis, hand: null }));
  });
}

function bjVolgendeSpeler() {
  for (let i = 0; i < spelers.length; i++) {
    if (bjStatus[spelers[i].id] === 'wachten') {
      bjBeurtIndex = i;
      bjStatus[spelers[i].id] = 'bezig';
      return true;
    }
  }
  return false;
}

function bjDealerFase() {
  bjFase = 'dealer';
  stuurBjStatus();
  while (bjHandWaarde(bjDealerHand) < 17 && bjDekBj.length > 0)
    bjDealerHand.push(bjDekBj.pop());
  const dealerWaarde = bjHandWaarde(bjDealerHand);
  const dealerBj = dealerWaarde === 21 && bjDealerHand.length === 2;
  spelers.forEach(sp => {
    const spWaarde = bjHandWaarde(bjSpelerHanden[sp.id] || []);
    const st = bjStatus[sp.id];
    if (st === 'gebust') {
      bjResultaten[sp.id] = 'verloren';
    } else if (st === 'blackjack') {
      bjResultaten[sp.id] = dealerBj ? 'gelijkspel' : 'blackjack';
      if (!dealerBj) winnen[sp.naam] = (winnen[sp.naam] || 0) + 1;
    } else if (dealerWaarde > 21 || spWaarde > dealerWaarde) {
      bjResultaten[sp.id] = 'gewonnen';
      winnen[sp.naam] = (winnen[sp.naam] || 0) + 1;
    } else if (spWaarde === dealerWaarde) {
      bjResultaten[sp.id] = 'gelijkspel';
    } else {
      bjResultaten[sp.id] = 'verloren';
    }
  });
  bjFase = 'klaar';
  bjGestart = false;
  stuurBjStatus();
}

function broadcast(data) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN)
      client.send(JSON.stringify(data));
  });
}

function stuurSpelStatus() {
  const basis = {
    type: 'spelstatus',
    stapelTop: stapel[stapel.length - 1],
    beurt: spelers[beurtIndex]?.id,
    spelers: spelers.map(s => ({
      id: s.id,
      naam: s.naam,
      aantalKaarten: handen[s.id]?.length,
      wins: winnen[s.naam] || 0
    })),
    extraBeurt,
    dekAantal: dek.length,
    moetLaatsteKaartRoepen: [...moetLaatsteKaartRoepen]
  };

  const spelerWsSet = new Set(spelers.map(s => s.ws));

  spelers.forEach(sp => {
    if (sp.ws.readyState === WebSocket.OPEN) {
      sp.ws.send(JSON.stringify({
        ...basis,
        hand: handen[sp.id],
        moetPakken: spelers[beurtIndex]?.id === sp.id ? moetPakken : 0
      }));
    }
  });

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
  if (kaart.waarde === 'JOKER') return true;
  if (top.waarde === 'JOKER') return true;
  return kaart.kleur === top.kleur || kaart.waarde === top.waarde;
}

wss.on('connection', (ws) => {
  const id = Date.now().toString();
  let isSpectator = false;

  ws.send(JSON.stringify({ type: 'modusGekozen', modus: spelModus }));

  ws.on('message', (msg) => {
    const data = JSON.parse(msg);

    if (data.type === 'joinSpectator') {
      isSpectator = true;
      ws.send(JSON.stringify({ type: 'wachtkamer', spelers: spelers.map(s => s.naam) }));
      ws.send(JSON.stringify({ type: 'modusGekozen', modus: spelModus }));
      if (spelModus === 'pesten' && gestart) {
        ws.send(JSON.stringify({
          type: 'spelstatus',
          stapelTop: stapel[stapel.length - 1],
          beurt: spelers[beurtIndex]?.id,
          spelers: spelers.map(s => ({ id: s.id, naam: s.naam, aantalKaarten: handen[s.id]?.length, wins: winnen[s.naam] || 0 })),
          extraBeurt,
          moetPakken,
          dekAantal: dek.length,
          hand: null,
          moetLaatsteKaartRoepen: [...moetLaatsteKaartRoepen]
        }));
      } else if (spelModus === 'blackjack' && (bjGestart || bjFase === 'klaar')) {
        stuurBjStatus();
      }
    }

    if (data.type === 'join') {
      if (gestart || (bjGestart && bjFase === 'spelen')) { ws.send(JSON.stringify({ type: 'fout', bericht: 'Spel al gestart' })); return; }
      spelers.push({ id, naam: data.naam, ws });
      handen[id] = [];
      broadcast({ type: 'wachtkamer', spelers: spelers.map(s => s.naam) });
      ws.send(JSON.stringify({ type: 'jouwId', id }));
    }

    if (data.type === 'kiesModus') {
      if (gestart || (bjGestart && bjFase === 'spelen')) return;
      spelModus = data.modus === 'blackjack' ? 'blackjack' : 'pesten';
      broadcast({ type: 'modusGekozen', modus: spelModus });
    }

    if (data.type === 'start') {
      if (spelModus === 'blackjack') {
        if (spelers.length < 1) { ws.send(JSON.stringify({ type: 'fout', bericht: 'Minimaal 1 speler nodig' })); return; }
        bjGestart = true;
        bjFase = 'spelen';
        bjDekBj = maakDek().filter(k => k.waarde !== 'JOKER').sort(() => Math.random() - 0.5);
        bjDealerHand = [];
        bjSpelerHanden = {};
        bjStatus = {};
        bjResultaten = {};
        bjBeurtIndex = 0;
        spelers.forEach(sp => {
          bjSpelerHanden[sp.id] = [bjDekBj.pop(), bjDekBj.pop()];
          bjStatus[sp.id] = bjHandWaarde(bjSpelerHanden[sp.id]) === 21 ? 'blackjack' : 'wachten';
        });
        bjDealerHand = [bjDekBj.pop(), bjDekBj.pop()];
        if (!bjVolgendeSpeler()) { bjDealerFase(); return; }
        stuurBjStatus();
        return;
      }
      if (spelers.length < 2) { ws.send(JSON.stringify({ type: 'fout', bericht: 'Minimaal 2 spelers nodig' })); return; }
      gestart = true;
      dek = maakDek();
      spelers.forEach(sp => { handen[sp.id] = dek.splice(0, 7); });
      stapel.push(dek.splice(0, 1)[0]);
      extraBeurt = false;
      moetPakken = 0;
      moetLaatsteKaartRoepen = new Set();
      beurtIndex = 0;
      stuurSpelStatus();
    }

    if (data.type === 'bjHit') {
      if (!bjGestart || bjFase !== 'spelen') return;
      if (spelers[bjBeurtIndex]?.id !== id) return;
      if (bjStatus[id] !== 'bezig') return;
      bjSpelerHanden[id].push(bjDekBj.pop());
      const waarde = bjHandWaarde(bjSpelerHanden[id]);
      if (waarde > 21) {
        bjStatus[id] = 'gebust';
        if (!bjVolgendeSpeler()) { bjDealerFase(); return; }
      } else if (waarde === 21) {
        bjStatus[id] = 'gepast';
        if (!bjVolgendeSpeler()) { bjDealerFase(); return; }
      }
      stuurBjStatus();
    }

    if (data.type === 'bjStand') {
      if (!bjGestart || bjFase !== 'spelen') return;
      if (spelers[bjBeurtIndex]?.id !== id) return;
      if (bjStatus[id] !== 'bezig') return;
      bjStatus[id] = 'gepast';
      if (!bjVolgendeSpeler()) { bjDealerFase(); return; }
      stuurBjStatus();
    }

    if (data.type === 'speelKaart') {
      const speler = spelers.find(s => s.id === id);
      if (!speler || spelers[beurtIndex].id !== id) return;

      const kaart = handen[id].find(k => k.id === data.kaartId);
      const top = stapel[stapel.length - 1];

      if (moetPakken > 0) {
        const kanStapelen = kaart && (kaart.waarde === '2' || kaart.waarde === 'JOKER') && kaartMagGespeeld(kaart, top);
        if (!kanStapelen) {
          ws.send(JSON.stringify({ type: 'fout', bericht: 'Je moet kaarten pakken, een 2 opleggen of een joker opleggen!' }));
          return;
        }
      } else if (!kaart || !kaartMagGespeeld(kaart, top)) {
        ws.send(JSON.stringify({ type: 'fout', bericht: 'Deze kaart mag je niet spelen!' }));
        return;
      }

      handen[id] = handen[id].filter(k => k.id !== data.kaartId);
      stapel.push(kaart);

      // Laatste kaart tracking: 1 kaart over = moet roepen
      if (handen[id].length === 1) {
        moetLaatsteKaartRoepen.add(id);
      }

      if (handen[id].length === 0) {
        winnen[speler.naam] = (winnen[speler.naam] || 0) + 1;
        broadcast({ type: 'gewonnen', naam: speler.naam, wins: winnen[speler.naam] });
        gestart = false;
        moetLaatsteKaartRoepen = new Set();
        spelers = []; handen = {}; dek = []; stapel = [];
        return;
      }

      if (kaart.waarde === 'JOKER') {
        moetPakken += 5;
        volgendeBeurt(1);
      } else if (kaart.waarde === '2') {
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
      moetLaatsteKaartRoepen.delete(id);
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

    if (data.type === 'chat') {
      const naam = spelers.find(s => s.id === id)?.naam || (isSpectator ? 'Kijker' : null);
      if (!naam) return;
      const bericht = String(data.bericht || '').slice(0, 120).trim();
      if (!bericht) return;
      broadcast({ type: 'chat', naam, bericht });
    }

    if (data.type === 'laatsTeKaart') {
      if (!moetLaatsteKaartRoepen.has(id)) return;
      moetLaatsteKaartRoepen.delete(id);
      const naam = spelers.find(s => s.id === id)?.naam || 'Onbekend';
      broadcast({ type: 'laatsTeKaartAangekondigd', naam });
      stuurSpelStatus();
    }

    if (data.type === 'vangLaatsTeKaart') {
      const doelId = data.doelId;
      if (!doelId || !moetLaatsteKaartRoepen.has(doelId)) return;
      if (handen[doelId]?.length !== 1) return;

      moetLaatsteKaartRoepen.delete(doelId);

      // Herstel dek als leeg
      if (dek.length < 2) {
        const top = stapel.pop();
        dek = [...dek, ...stapel].sort(() => Math.random() - 0.5);
        stapel = [top];
      }
      handen[doelId].push(...dek.splice(0, Math.min(2, dek.length)));

      const doelNaam = spelers.find(s => s.id === doelId)?.naam || 'Onbekend';
      const vangerNaam = spelers.find(s => s.id === id)?.naam || (isSpectator ? 'Kijker' : 'Onbekend');
      broadcast({ type: 'gepakt', doelNaam, vangerNaam });
      stuurSpelStatus();
    }
  });

  ws.on('close', () => {
    if (isSpectator) return;
    moetLaatsteKaartRoepen.delete(id);

    // Blackjack: was het de beurt van de weggevallen speler?
    if (bjGestart && bjFase === 'spelen' && spelers[bjBeurtIndex]?.id === id) {
      bjStatus[id] = 'gepast';
      spelers = spelers.filter(s => s.id !== id);
      delete bjSpelerHanden[id];
      if (spelers.length === 0 || !bjVolgendeSpeler()) { bjDealerFase(); return; }
      stuurBjStatus();
      return;
    }

    spelers = spelers.filter(s => s.id !== id);
    delete handen[id];
    if (gestart && spelers.length < 2) {
      broadcast({ type: 'fout', bericht: 'Een speler heeft de verbinding verbroken' });
      gestart = false;
      moetLaatsteKaartRoepen = new Set();
    } else {
      broadcast({ type: 'wachtkamer', spelers: spelers.map(s => s.naam) });
    }
  });
});

server.listen(3000, () => console.log('Pesten draait op http://localhost:3000'));
