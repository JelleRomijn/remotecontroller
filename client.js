const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
const ws = new WebSocket(`${wsProtocol}//${location.host}`);

let wsKlaar = false;
let mijnId = null;
let mijnBeurt = false;
let schermType = null; // 'speler' of 'kijkscherm'
let vorigeHandIds = new Set();
let vorigeStapelTopId = null;
let spelModus = 'pesten';
let ongelezeChatBerichten = 0;
let mijnLobbyId = null;

ws.onopen = () => {
  wsKlaar = true;
  console.log('WebSocket verbonden');
};

ws.onclose = () => {
  wsKlaar = false;
  console.log('WebSocket verbinding gesloten');
};

ws.onerror = (err) => {
  console.log('WebSocket fout:', err);
};

function stuurNaarServer(data) {
  if (!wsKlaar || ws.readyState !== WebSocket.OPEN) {
    toonMelding('Verbinding nog niet klaar. Probeer opnieuw.', 'fout');
    return false;
  }

  ws.send(JSON.stringify(data));
  return true;
}

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);

  if (data.type === 'lobbyAangemaakt' || data.type === 'lobbyGejoint') {
    mijnLobbyId = data.lobbyId;
    document.getElementById('lobby-keuze').style.display = 'none';
    document.getElementById('scherm-keuze').style.display = 'block';
    document.getElementById('lobby-badge-code').textContent = data.lobbyId;
    document.getElementById('lobby-badge').style.display = 'block';
    return;
  }

  if (data.type === 'jouwId') {
    mijnId = data.id;
    document.getElementById('start-btn').style.display = 'block';
  }

  if (data.type === 'wachtkamer') {
    const namen = data.spelers;
    const lijst = document.getElementById('wachtkamer-lijst');
    if (lijst) lijst.textContent = namen.join(', ') || 'Nog niemand...';
    if (schermType === 'kijkscherm') {
      document.getElementById('host-spelers-count').textContent =
        `${namen.length} speler${namen.length !== 1 ? 's' : ''} verbonden`;
    }
  }

  if (data.type === 'spelstatus') {
    mijnBeurt = data.beurt === mijnId;
    if (schermType === 'kijkscherm') {
      renderHostView(data);
    } else if (schermType === 'speler') {
      renderSpelerView(data);
    }
  }

  if (data.type === 'fout') {
    if (!mijnLobbyId) {
      const el = document.getElementById('lobby-fout');
      if (el) {
        el.textContent = data.bericht;
        el.style.opacity = '1';
        clearTimeout(el._timer);
        el._timer = setTimeout(() => { el.style.opacity = '0'; }, 3000);
      }
    } else {
      toonMelding(data.bericht, 'fout');
    }
  }

  if (data.type === 'gewonnen') {
    if (schermType === 'kijkscherm') {
      document.getElementById('host-status-tekst').textContent =
        `🏆 ${data.naam} heeft gewonnen! (${data.wins} totaal)`;
      document.getElementById('host-verborgen-kaarten').innerHTML = '';
    } else {
      toonGewonnenOverlay(data.naam, data.wins);
    }
  }

  if (data.type === 'modusGekozen') {
    spelModus = data.modus;
    document.querySelectorAll('.modus-btn').forEach((b, i) => {
      b.classList.toggle('actief', (i === 0 && data.modus === 'pesten') || (i === 1 && data.modus === 'blackjack'));
    });
    if (schermType === 'kijkscherm') {
      document.getElementById('host-view').style.display = data.modus === 'pesten' ? 'block' : 'none';
      document.getElementById('bj-host-view').style.display = data.modus === 'blackjack' ? 'block' : 'none';
    }
  }

  if (data.type === 'bjStatus') {
    if (schermType === 'kijkscherm') {
      renderBjHostView(data);
    } else if (schermType === 'speler') {
      renderBjSpelerView(data);
    }
  }

  if (data.type === 'chat') {
    voegChatToe(data.naam, data.bericht);
  }

  if (data.type === 'laatsTeKaartAangekondigd') {
    voegChatToe('🃏', `${data.naam} roept LAATSTE KAART!`);
    toonMelding(`${data.naam} roept LAATSTE KAART!`, 'info');
  }

  if (data.type === 'gepakt') {
    voegChatToe('😂', `${data.vangerNaam} pakt ${data.doelNaam}! +2 kaarten straf`);
    toonMelding(`${data.doelNaam} wordt gepakt door ${data.vangerNaam}! +2 kaarten`, 'fout');
  }
};

function maakLobby() {
  stuurNaarServer({ type: 'maakLobby' });
}

function joinLobbyMet() {
  const code = document.getElementById('lobby-code-input').value.trim().toUpperCase();
  if (!code) return;
  stuurNaarServer({ type: 'joinLobby', lobbyId: code });
}

function kiesScherm(type) {
  schermType = type;
  document.getElementById('scherm-keuze').style.display = 'none';
  document.getElementById('chat-container').style.display = 'block';

  if (type === 'kijkscherm') {
    document.getElementById('lobby').style.display = 'none';
    document.getElementById('host-view').style.display = 'block';
    stuurNaarServer({ type: 'joinSpectator' });
  } else {
    document.getElementById('speler-lobby').style.display = 'block';
  }
}

// --- Gewonnen overlay ---
function toonGewonnenOverlay(naam, wins) {
  const overlay = document.getElementById('gewonnen-overlay');
  document.getElementById('gewonnen-naam').textContent = naam;
  document.getElementById('gewonnen-wins').textContent =
    wins > 1 ? `${wins}e overwinning dit potjesblok!` : 'Eerste overwinning!';
  overlay.style.display = 'flex';
  setTimeout(() => location.reload(), 5000);
}

// --- Host / kijkscherm rendering ---
function renderHostView(data) {
  document.getElementById('host-spelers-count').textContent =
    `${data.spelers.length} speler${data.spelers.length !== 1 ? 's' : ''} verbonden`;

  document.getElementById('host-spelers').innerHTML = data.spelers.map(sp => {
    const actief = sp.id === data.beurt;
    const winsHtml = sp.wins > 0 ? `<div class="host-speler-wins">🏆 ${sp.wins} gewonnen</div>` : '';
    return `<div class="host-speler-box${actief ? ' actief' : ''}">
      <div class="host-speler-naam">${sp.naam}</div>
      <div class="host-speler-aantal">${sp.aantalKaarten}</div>
      <div class="host-speler-label">kaarten</div>
      ${winsHtml}
      ${actief ? '<div class="host-speler-beurt">aan de beurt</div>' : ''}
    </div>`;
  }).join('');

  document.getElementById('host-dek-count').textContent = `${data.dekAantal} kaarten`;

  const top = data.stapelTop;
  if (top) {
    const isGewijzigd = top.id !== vorigeStapelTopId;
    if (top.waarde === 'JOKER') {
      document.getElementById('host-stapel-kaart').className = 'host-stapel-kaart' + (isGewijzigd ? ' stapel-update' : '');
      document.getElementById('host-stapel-kaart').style.background = '#2c3e50';
      document.getElementById('host-hoek-lb').innerHTML = '';
      document.getElementById('host-midden-kleur').textContent = '🃏';
      document.getElementById('host-hoek-ro').innerHTML = '';
    } else {
      const isRood = top.kleur === '♥' || top.kleur === '♦';
      document.getElementById('host-stapel-kaart').className = 'host-stapel-kaart' + (isRood ? ' rood' : '') + (isGewijzigd ? ' stapel-update' : '');
      document.getElementById('host-stapel-kaart').style.background = '';
      document.getElementById('host-hoek-lb').innerHTML = `${top.waarde}<br>${top.kleur}`;
      document.getElementById('host-midden-kleur').textContent = top.kleur;
      document.getElementById('host-hoek-ro').innerHTML = `${top.waarde}<br>${top.kleur}`;
    }
    vorigeStapelTopId = top.id;
  }

  const beurtSpeler = data.spelers.find(s => s.id === data.beurt);
  if (beurtSpeler) {
    const statusEl = document.getElementById('host-status-tekst');
    if (data.moetPakken > 0) {
      statusEl.textContent = `${beurtSpeler.naam} moet ${data.moetPakken} kaarten pakken!`;
    } else if (data.extraBeurt) {
      statusEl.textContent = `${beurtSpeler.naam} speelt een extra kaart...`;
    } else {
      statusEl.textContent = `${beurtSpeler.naam} speelt een kaart...`;
    }

    document.getElementById('host-verborgen-kaarten').innerHTML = Array(beurtSpeler.aantalKaarten).fill('')
      .map(() => '<div class="host-verborgen-kaart"></div>')
      .join('');
  }
}

// --- Speler rendering ---
function renderSpelerView(data) {
  document.getElementById('lobby').style.display = 'none';
  document.getElementById('spel').style.display = 'block';

  const banner = document.getElementById('beurt-banner');
  if (mijnBeurt) {
    if (data.moetPakken > 0) {
      banner.textContent = `Je moet ${data.moetPakken} kaarten pakken! Leg een 2 of joker op, of klik het dek.`;
    } else {
      banner.textContent = data.extraBeurt ? 'Leg een 2e kaart of pak een kaart!' : 'Jouw beurt!';
    }
    banner.className = 'beurt-banner jouw-beurt banner-puls';
  } else {
    const beurtSpeler = data.spelers.find(s => s.id === data.beurt);
    banner.textContent = `Beurt van ${beurtSpeler?.naam || '...'}`;
    banner.className = 'beurt-banner wacht-beurt';
  }

  document.getElementById('spelers-lijst').innerHTML = data.spelers.map(sp => {
    const winsHtml = sp.wins > 0 ? `<span class="wins-badge">🏆${sp.wins}</span>` : '';
    return `<span class="speler-badge ${sp.id === data.beurt ? 'actief' : ''}">${sp.naam} (${sp.aantalKaarten})${winsHtml}</span>`;
  }).join('');

  const top = data.stapelTop;
  const stapelEl = document.getElementById('stapel-top');
  const isGewijzigd = top.id !== vorigeStapelTopId;
  if (top.waarde === 'JOKER') {
    stapelEl.className = 'kaart joker' + (isGewijzigd ? ' stapel-update' : '');
    stapelEl.textContent = '🃏';
  } else {
    stapelEl.className = 'kaart' + ((top.kleur === '♥' || top.kleur === '♦') ? ' rood' : '') + (isGewijzigd ? ' stapel-update' : '');
    stapelEl.textContent = `${top.waarde}${top.kleur}`;
  }
  vorigeStapelTopId = top.id;

  const moetRoepen = data.moetLaatsteKaartRoepen || [];
  const ikMoetRoepen = moetRoepen.includes(mijnId);
  const anderenDieRoepenMoeten = moetRoepen.filter(id => id !== mijnId);

  const sectie = document.getElementById('laatste-kaart-sectie');
  const laatsTeKaartBtn = document.getElementById('laatste-kaart-btn');
  const pakKnoppen = document.getElementById('pak-knoppen');

  laatsTeKaartBtn.style.display = ikMoetRoepen ? 'block' : 'none';

  pakKnoppen.innerHTML = anderenDieRoepenMoeten.map(id => {
    const sp = data.spelers.find(s => s.id === id);
    return sp ? `<button class="pak-knop" onclick="vangSpeler('${sp.id}')">😱 Pak ${sp.naam}!</button>` : '';
  }).join('');

  sectie.style.display = (ikMoetRoepen || anderenDieRoepenMoeten.length > 0) ? 'block' : 'none';

  const handEl = document.getElementById('hand');
  handEl.innerHTML = '';
  data.hand.forEach(kaart => {
    const isRood = kaart.kleur === '♥' || kaart.kleur === '♦';
    const isNieuw = !vorigeHandIds.has(kaart.id);
    const speelbaar = mijnBeurt && (
      data.moetPakken > 0
        ? (kaart.waarde === '2' || kaart.waarde === 'JOKER') && kaartMagGespeeld(kaart, top)
        : kaartMagGespeeld(kaart, top)
    );
    const isJoker = kaart.waarde === 'JOKER';
    const el = document.createElement('div');
    el.className = 'kaart'
      + (isRood ? ' rood' : '')
      + (isJoker ? ' joker' : '')
      + (speelbaar ? ' speelbaar' : '')
      + (isNieuw ? ' kaart-nieuw' : '');
    el.textContent = isJoker ? '🃏\nJOKER' : `${kaart.waarde}${kaart.kleur}`;
    if (isJoker) el.style.whiteSpace = 'pre';
    if (speelbaar) el.onclick = () => speelKaart(kaart.id);
    handEl.appendChild(el);
  });
  vorigeHandIds = new Set(data.hand.map(k => k.id));
}

function kaartMagGespeeld(kaart, top) {
  if (kaart.waarde === 'JOKER') return true;
  if (top.waarde === 'JOKER') return true;
  return kaart.kleur === top.kleur || kaart.waarde === top.waarde;
}

function speelKaart(kaartId) {
  stuurNaarServer({ type: 'speelKaart', kaartId });
}

function pakKaart() {
  if (!mijnBeurt) return;
  stuurNaarServer({ type: 'pakKaart' });
}

function joinSpel() {
  const naam = document.getElementById('naam-input').value.trim();
  if (!naam) {
    toonMelding('Vul een naam in!', 'fout');
    return;
  }
  stuurNaarServer({ type: 'join', naam });
}

function startSpel() {
  stuurNaarServer({ type: 'start' });
}

function roepLaatsteKaart() {
  stuurNaarServer({ type: 'laatsTeKaart' });
}

function vangSpeler(doelId) {
  stuurNaarServer({ type: 'vangLaatsTeKaart', doelId });
}

// --- Chat ---
function toggleChat() {
  const box = document.getElementById('chat-box');
  const isOpen = box.style.display === 'flex';
  box.style.display = isOpen ? 'none' : 'flex';
  if (!isOpen) {
    document.getElementById('chat-input').focus();
    document.getElementById('chat-badge').style.display = 'none';
    document.getElementById('chat-badge').textContent = '';
    ongelezeChatBerichten = 0;
  }
}

function voegChatToe(naam, bericht) {
  const berichten = document.getElementById('chat-berichten');
  const div = document.createElement('div');
  div.className = 'chat-bericht';
  div.innerHTML = `<span class="chat-naam">${naam}:</span> ${bericht}`;
  berichten.appendChild(div);
  berichten.scrollTop = berichten.scrollHeight;

  const box = document.getElementById('chat-box');
  if (box.style.display !== 'flex') {
    ongelezeChatBerichten++;
    const badge = document.getElementById('chat-badge');
    badge.textContent = ongelezeChatBerichten;
    badge.style.display = 'inline-block';
  }
}

function stuurChat() {
  const input = document.getElementById('chat-input');
  const bericht = input.value.trim();
  if (!bericht) return;
  stuurNaarServer({ type: 'chat', bericht });
  input.value = '';
}

function chatKeyDown(e) {
  if (e.key === 'Enter') stuurChat();
}

// --- Feedback meldingen ---
function toonMelding(tekst, soort = 'info') {
  ['melding', 'melding-bj'].forEach(elId => {
    const el = document.getElementById(elId);
    if (!el) return;
    el.textContent = tekst;
    el.className = 'melding melding-' + soort;
    el.style.opacity = '1';
    clearTimeout(el._timer);
    el._timer = setTimeout(() => {
      el.style.opacity = '0';
      setTimeout(() => {
        el.textContent = '';
        el.className = 'melding';
      }, 300);
    }, 3000);
  });
}

// --- Blackjack ---
function kiesModus(modus) {
  stuurNaarServer({ type: 'kiesModus', modus });
}

function bjHit() {
  stuurNaarServer({ type: 'bjHit' });
}

function bjStand() {
  stuurNaarServer({ type: 'bjStand' });
}

function maakBjKaartEl(kaart) {
  const el = document.createElement('div');
  if (kaart.verborgen) {
    el.className = 'kaart dek-kaart';
    el.textContent = '🂠';
    return el;
  }
  const isRood = kaart.kleur === '♥' || kaart.kleur === '♦';
  el.className = 'kaart' + (isRood ? ' rood' : '');
  el.textContent = `${kaart.waarde}${kaart.kleur}`;
  return el;
}

function bjStatusLabel(status) {
  return {
    wachten: 'wacht...',
    bezig: 'speelt',
    gepast: 'gepast',
    gebust: 'te veel!',
    blackjack: 'Blackjack!'
  }[status] || status;
}

function bjResultaatTekst(res) {
  return {
    gewonnen: '🏆 Gewonnen!',
    verloren: '💸 Verloren',
    gelijkspel: '🤝 Gelijkspel',
    blackjack: '🃏 Blackjack!'
  }[res] || res;
}

function renderBjSpelerView(data) {
  document.getElementById('lobby').style.display = 'none';
  document.getElementById('spel').style.display = 'none';
  document.getElementById('bj-spel').style.display = 'block';

  const dealerHandEl = document.getElementById('bj-dealer-hand');
  dealerHandEl.innerHTML = '';
  (data.dealerHand || []).forEach(k => dealerHandEl.appendChild(maakBjKaartEl(k)));
  document.getElementById('bj-dealer-waarde').textContent =
    data.dealerWaarde !== null ? data.dealerWaarde : '?';

  document.getElementById('bj-spelers-rij').innerHTML = data.spelers.map(sp => {
    const winsHtml = sp.wins > 0 ? `<span class="wins-badge">🏆${sp.wins}</span>` : '';
    const resHtml = sp.resultaat ? `<span class="bj-res-${sp.resultaat}">${bjResultaatTekst(sp.resultaat)}</span>` : '';
    return `<div class="bj-speler-box ${sp.status}${sp.id === data.beurt ? ' beurt' : ''}">
      <div class="bj-speler-naam">${sp.naam}${winsHtml}</div>
      <div class="bj-speler-waarde">${sp.waarde}</div>
      <div class="bj-speler-label">${bjStatusLabel(sp.status)}</div>
      ${resHtml}
    </div>`;
  }).join('');

  const mijnSpeler = data.spelers.find(s => s.id === mijnId);
  const mijnHandEl = document.getElementById('bj-mijn-hand');
  mijnHandEl.innerHTML = '';
  (data.hand || []).forEach(k => mijnHandEl.appendChild(maakBjKaartEl(k)));
  document.getElementById('bj-mijn-waarde').textContent = mijnSpeler ? mijnSpeler.waarde : '';

  const bannerEl = document.getElementById('bj-beurt-banner');
  if (data.fase === 'klaar') {
    bannerEl.style.display = 'none';
  } else if (data.beurt === mijnId) {
    bannerEl.textContent = 'Jouw beurt!';
    bannerEl.className = 'beurt-banner jouw-beurt banner-puls';
    bannerEl.style.display = 'block';
  } else if (data.fase === 'dealer') {
    bannerEl.textContent = 'Deler speelt...';
    bannerEl.className = 'beurt-banner wacht-beurt';
    bannerEl.style.display = 'block';
  } else {
    const beurtSpeler = data.spelers.find(s => s.id === data.beurt);
    bannerEl.textContent = `Beurt van ${beurtSpeler?.naam || '...'}`;
    bannerEl.className = 'beurt-banner wacht-beurt';
    bannerEl.style.display = 'block';
  }

  const isAanBeurt = data.beurt === mijnId && mijnSpeler?.status === 'bezig';
  document.getElementById('bj-actie-btns').style.display = isAanBeurt ? 'flex' : 'none';

  const resultaatEl = document.getElementById('bj-resultaat-sectie');
  if (data.fase === 'klaar' && mijnSpeler?.resultaat) {
    const res = mijnSpeler.resultaat;
    resultaatEl.innerHTML = `<div class="bj-uitslag bj-uitslag-${res}">${bjResultaatTekst(res)}</div>`;
    resultaatEl.style.display = 'block';
    document.getElementById('bj-nieuw-potje-btn').style.display = 'block';
  } else {
    resultaatEl.style.display = 'none';
    document.getElementById('bj-nieuw-potje-btn').style.display = 'none';
  }
}

function renderBjHostView(data) {
  document.getElementById('host-view').style.display = 'none';
  document.getElementById('bj-host-view').style.display = 'block';

  document.getElementById('bj-host-spelers-count').textContent =
    `${data.spelers.length} speler${data.spelers.length !== 1 ? 's' : ''}`;

  document.getElementById('bj-host-spelers').innerHTML = data.spelers.map(sp => {
    const actief = sp.id === data.beurt && data.fase === 'spelen';
    const winsHtml = sp.wins > 0 ? `<div class="host-speler-wins">🏆 ${sp.wins}</div>` : '';
    const resHtml = sp.resultaat ? `<div class="host-speler-wins">${bjResultaatTekst(sp.resultaat)}</div>` : '';
    return `<div class="host-speler-box${actief ? ' actief' : ''}">
      <div class="host-speler-naam">${sp.naam}</div>
      <div class="host-speler-aantal">${sp.waarde}</div>
      <div class="host-speler-label">${bjStatusLabel(sp.status)}</div>
      ${winsHtml}${resHtml}
    </div>`;
  }).join('');

  const dealerHandEl = document.getElementById('bj-host-dealer-hand');
  dealerHandEl.innerHTML = '';
  (data.dealerHand || []).forEach(k => dealerHandEl.appendChild(maakBjKaartEl(k)));
  document.getElementById('bj-host-dealer-waarde').textContent =
    data.dealerWaarde !== null ? data.dealerWaarde : '?';

  document.getElementById('bj-host-status').textContent =
    data.fase === 'spelen' ? `${data.spelers.find(s => s.id === data.beurt)?.naam || '?'} speelt...` :
    data.fase === 'dealer' ? 'Deler speelt...' :
    data.fase === 'klaar' ? 'Ronde klaar!' : 'Wachten op spelers...';
}