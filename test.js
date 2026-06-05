const https = require('https');

const key = "PASTE_YOUR_KEY_HERE";

const body = JSON.stringify({
  model: "llama-3.1-8b-instant",
  messages: [{ role: "user", content: "say hi" }]
});

const options = {
  hostname: 'api.groq.com',
  path: '/openai/v1/chat/completions',
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body)
  }
};

const req = https.request(options, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => console.log(data));
});

req.on('error', e => console.error(e));
req.write(body);
req.end();