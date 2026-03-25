const ws = new WebSocket(`ws://${location.host}`);
let mijnId = null;
let mijnBeurt = false;
let schermType = null; // 'speler' of 'kijkscherm'

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);

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
    toonMelding(data.bericht);
  }

  if (data.type === 'gewonnen') {
    if (schermType === 'kijkscherm') {
      document.getElementById('host-status-tekst').textContent = `${data.naam} heeft gewonnen!`;
      document.getElementById('host-verborgen-kaarten').innerHTML = '';
    } else {
      alert(`${data.naam} heeft gewonnen!`);
      location.reload();
    }
  }
};

function kiesScherm(type) {
  schermType = type;
  document.getElementById('scherm-keuze').style.display = 'none';

  if (type === 'kijkscherm') {
    document.getElementById('lobby').style.display = 'none';
    document.getElementById('host-view').style.display = 'block';
    ws.send(JSON.stringify({ type: 'joinSpectator' }));
  } else {
    document.getElementById('speler-lobby').style.display = 'block';
  }
}

// --- Host / kijkscherm rendering ---

function renderHostView(data) {
  document.getElementById('host-spelers-count').textContent =
    `${data.spelers.length} speler${data.spelers.length !== 1 ? 's' : ''} verbonden`;

  // Scorebord
  document.getElementById('host-spelers').innerHTML = data.spelers.map(sp => {
    const actief = sp.id === data.beurt;
    return `<div class="host-speler-box${actief ? ' actief' : ''}">
      <div class="host-speler-naam">${sp.naam}</div>
      <div class="host-speler-aantal">${sp.aantalKaarten}</div>
      <div class="host-speler-label">kaarten</div>
      ${actief ? '<div class="host-speler-beurt">aan de beurt</div>' : ''}
    </div>`;
  }).join('');

  // Dek
  document.getElementById('host-dek-count').textContent = `${data.dekAantal} kaarten`;

  // Stapel (speelkaart layout)
  const top = data.stapelTop;
  if (top) {
    const isRood = top.kleur === '♥' || top.kleur === '♦';
    document.getElementById('host-stapel-kaart').className = 'host-stapel-kaart' + (isRood ? ' rood' : '');
    document.getElementById('host-hoek-lb').innerHTML = `${top.waarde}<br>${top.kleur}`;
    document.getElementById('host-midden-kleur').textContent = top.kleur;
    document.getElementById('host-hoek-ro').innerHTML = `${top.waarde}<br>${top.kleur}`;
  }

  // Status tekst
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

    // Face-down kaarten van huidige speler
    document.getElementById('host-verborgen-kaarten').innerHTML = Array(beurtSpeler.aantalKaarten).fill('')
      .map(() => '<div class="host-verborgen-kaart"></div>')
      .join('');
  }
}

// --- Speler rendering ---

function renderSpelerView(data) {
  document.getElementById('lobby').style.display = 'none';
  document.getElementById('spel').style.display = 'block';

  // Beurt banner
  const banner = document.getElementById('beurt-banner');
  if (mijnBeurt) {
    if (data.moetPakken > 0) {
      banner.textContent = `Je moet ${data.moetPakken} kaarten pakken! Leg een 2 op of klik het dek.`;
    } else {
      banner.textContent = data.extraBeurt ? 'Leg een 2e kaart of pak een kaart!' : 'Jouw beurt!';
    }
    banner.className = 'beurt-banner jouw-beurt';
  } else {
    const beurtSpeler = data.spelers.find(s => s.id === data.beurt);
    banner.textContent = `Beurt van ${beurtSpeler?.naam || '...'}`;
    banner.className = 'beurt-banner wacht-beurt';
  }

  // Spelers badges
  document.getElementById('spelers-lijst').innerHTML = data.spelers.map(sp =>
    `<span class="speler-badge ${sp.id === data.beurt ? 'actief' : ''}">${sp.naam} (${sp.aantalKaarten})</span>`
  ).join('');

  // Stapel top
  const top = data.stapelTop;
  const stapelEl = document.getElementById('stapel-top');
  stapelEl.className = 'kaart' + ((top.kleur === '♥' || top.kleur === '♦') ? ' rood' : '');
  stapelEl.textContent = `${top.waarde}${top.kleur}`;

  // Eigen hand
  const handEl = document.getElementById('hand');
  handEl.innerHTML = '';
  data.hand.forEach(kaart => {
    const isRood = kaart.kleur === '♥' || kaart.kleur === '♦';
    const speelbaar = mijnBeurt && (
      data.moetPakken > 0
        ? kaart.waarde === '2' && kaartMagGespeeld(kaart, top)
        : kaartMagGespeeld(kaart, top)
    );
    const el = document.createElement('div');
    el.className = 'kaart' + (isRood ? ' rood' : '') + (speelbaar ? ' speelbaar' : '');
    el.textContent = `${kaart.waarde}${kaart.kleur}`;
    if (speelbaar) el.onclick = () => speelKaart(kaart.id);
    handEl.appendChild(el);
  });
}

function kaartMagGespeeld(kaart, top) {
  return kaart.kleur === top.kleur || kaart.waarde === top.waarde;
}

function speelKaart(kaartId) {
  ws.send(JSON.stringify({ type: 'speelKaart', kaartId }));
}

function pakKaart() {
  if (!mijnBeurt) return;
  ws.send(JSON.stringify({ type: 'pakKaart' }));
}

function joinSpel() {
  const naam = document.getElementById('naam-input').value.trim();
  if (!naam) { alert('Vul een naam in!'); return; }
  ws.send(JSON.stringify({ type: 'join', naam }));
}

function startSpel() {
  ws.send(JSON.stringify({ type: 'start' }));
}

function toonMelding(tekst) {
  const el = document.getElementById('melding');
  if (!el) return;
  el.textContent = tekst;
  setTimeout(() => el.textContent = '', 3000);
}
