// r2-storage.js
//
// Cloudflare R2 storage adapter for manga pages/covers.
// Separate from the GitHub-backed sync in server.js on purpose - the novel
// side keeps working exactly as-is. This module is inert until the R2_*
// env vars below are set in Render, so merging/deploying this file changes
// nothing until you actually flip it on.
//
// Required Render env vars (all four, once you have an R2 bucket):
//   R2_ACCOUNT_ID       - Cloudflare account ID
//   R2_ACCESS_KEY_ID    - R2 API token access key
//   R2_SECRET_ACCESS_KEY- R2 API token secret
//   R2_BUCKET           - bucket name
//
// npm dependency needed: @aws-sdk/client-s3
//   npm install @aws-sdk/client-s3

const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} = require('@aws-sdk/client-s3');

function getR2Config() {
  const accountId = (process.env.R2_ACCOUNT_ID || '').toString().trim();
  const accessKeyId = (process.env.R2_ACCESS_KEY_ID || '').toString().trim();
  const secretAccessKey = (process.env.R2_SECRET_ACCESS_KEY || '').toString().trim();
  const bucket = (process.env.R2_BUCKET || '').toString().trim();
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null;
  return { accountId, accessKeyId, secretAccessKey, bucket };
}

const r2Config = getR2Config();

let s3Client = null;
if (r2Config) {
  s3Client = new S3Client({
    region: 'auto',
    endpoint: `https://${r2Config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: r2Config.accessKeyId,
      secretAccessKey: r2Config.secretAccessKey,
    },
  });
  console.log('R2-backed manga storage enabled for bucket ' + r2Config.bucket);
} else {
  console.log('R2 storage not configured yet (R2_* env vars missing) - manga routes will return 503 until set.');
}

function isR2Configured() {
  return !!s3Client;
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// Uploads a buffer to R2 under `key` (e.g. "manga/one-piece/chapter-1/003.webp").
async function putObject(key, buffer, contentType) {
  if (!s3Client) throw Object.assign(new Error('R2 not configured'), { code: 'R2_NOT_CONFIGURED' });
  await s3Client.send(new PutObjectCommand({
    Bucket: r2Config.bucket,
    Key: key,
    Body: buffer,
    ContentType: contentType || 'application/octet-stream',
  }));
  return true;
}

// Returns { buffer, contentType } or null if the object doesn't exist.
async function getObject(key) {
  if (!s3Client) throw Object.assign(new Error('R2 not configured'), { code: 'R2_NOT_CONFIGURED' });
  try {
    const res = await s3Client.send(new GetObjectCommand({
      Bucket: r2Config.bucket,
      Key: key,
    }));
    const buffer = await streamToBuffer(res.Body);
    return { buffer, contentType: res.ContentType || 'application/octet-stream' };
  } catch (e) {
    if (e && (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404)) return null;
    throw e;
  }
}

async function objectExists(key) {
  if (!s3Client) throw Object.assign(new Error('R2 not configured'), { code: 'R2_NOT_CONFIGURED' });
  try {
    await s3Client.send(new HeadObjectCommand({ Bucket: r2Config.bucket, Key: key }));
    return true;
  } catch (e) {
    if (e && (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404)) return false;
    throw e;
  }
}

// Small JSON convenience wrappers - mirrors the shape of githubReadJson/
// githubWriteJson in server.js so the manga library index can use the same
// mental model as the novel side, just backed by R2 instead of GitHub.
async function getJson(key) {
  const obj = await getObject(key);
  if (!obj) return null;
  try {
    return JSON.parse(obj.buffer.toString('utf8'));
  } catch (e) {
    return null;
  }
}

async function putJson(key, value) {
  const buffer = Buffer.from(JSON.stringify(value || {}), 'utf8');
  return putObject(key, buffer, 'application/json');
}

module.exports = {
  isR2Configured,
  putObject,
  getObject,
  objectExists,
  getJson,
  putJson,
};
