const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: 8080 });

let nextId = 1;

wss.on('connection', ws => {
  ws.clientId = nextId++;
  console.log(`Client ${ws.clientId} connected`);

  ws.send(JSON.stringify({ type: 'init', id: ws.clientId }));

  ws.on('message', raw => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    if (data.type === 'message') {
      const payload = JSON.stringify({ type: 'message', text: data.text, from: ws.clientId });
      wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(payload);
        }
      });
    }

    if (data.type === 'ping') {
      wss.clients.forEach(client => {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ type: 'ping', from: ws.clientId }));
        }
      });
    }
  });

  ws.on('close', () => {
    console.log(`Client ${ws.clientId} disconnected`);
  });
});

console.log('WebSocket server started on port 8080');
