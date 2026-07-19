<<<<<<< HEAD
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', '.data');
const DATA_FILE = path.join(DATA_DIR, 'library.json');

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({}), 'utf8');
}

function readLibrary() {
  ensureDataFile();
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function writeLibrary(data) {
  ensureDataFile();
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

exports.handler = async function (event, context) {
  const key = event.queryStringParameters && event.queryStringParameters.key
    ? event.queryStringParameters.key.trim()
    : (event.headers && event.headers['x-sync-key'] ? event.headers['x-sync-key'].trim() : '');

  if (!key) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Missing sync key' })
    };
  }

  const store = readLibrary();
  if (!store[key]) store[key] = {};

  if (event.httpMethod === 'GET') {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: store[key] })
    };
  }

  if (event.httpMethod === 'POST') {
    let body = {};
    try {
      body = JSON.parse(event.body || '{}');
    } catch (e) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }

    store[key] = body;
    writeLibrary(store);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true })
    };
  }

  return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
};
=======
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', '.data');
const DATA_FILE = path.join(DATA_DIR, 'library.json');

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({}), 'utf8');
}

function readLibrary() {
  ensureDataFile();
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function writeLibrary(data) {
  ensureDataFile();
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

exports.handler = async function (event, context) {
  const key = event.queryStringParameters && event.queryStringParameters.key
    ? event.queryStringParameters.key.trim()
    : (event.headers && event.headers['x-sync-key'] ? event.headers['x-sync-key'].trim() : '');

  if (!key) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Missing sync key' })
    };
  }

  const store = readLibrary();
  if (!store[key]) store[key] = {};

  if (event.httpMethod === 'GET') {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: store[key] })
    };
  }

  if (event.httpMethod === 'POST') {
    let body = {};
    try {
      body = JSON.parse(event.body || '{}');
    } catch (e) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }

    store[key] = body;
    writeLibrary(store);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true })
    };
  }

  return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
};
>>>>>>> 42116c6 (Initial commit)
