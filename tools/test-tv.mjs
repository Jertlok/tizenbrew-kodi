// Self-check for tv.mjs: signs a small widget with a throwaway certificate and checks the
// signature files and their digests. Usage: node tools/test-tv.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { sign, packageId } from './tv.mjs';

const require = createRequire(import.meta.url);
const JSZip = require('jszip');
const forge = require('node-forge');

function p12(name) {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey; cert.serialNumber = '01';
  cert.validity.notBefore = new Date(); cert.validity.notAfter = new Date(Date.now() + 864e5);
  cert.setSubject([{ name: 'commonName', value: name }]); cert.setIssuer([{ name: 'commonName', value: name }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const der = forge.asn1.toDer(forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], 'pw', { algorithm: '3des' })).getBytes();
  return Buffer.from(der, 'binary').toString('base64');
}

const zip = new JSZip();
zip.file('config.xml', '<widget><tizen:application id="KodiWasmTv.Kodi" package="KodiWasmTv"/></widget>');
zip.file('index.html', '<p>kodi</p>');
zip.file('media/splash.jpg', 'jpg');
zip.file('author-signature.xml', 'old');   // an old signature is replaced
const signed = await sign(await zip.generateAsync({ type: 'nodebuffer' }),
  { authorCert: p12('author'), distributorCert: p12('distributor'), password: 'pw' });

const out = await JSZip.loadAsync(signed);
assert.deepEqual(Object.keys(out.files).filter((f) => !out.files[f].dir).sort(),
  ['author-signature.xml', 'config.xml', 'index.html', 'media/splash.jpg', 'signature1.xml']);
const author = await out.file('author-signature.xml').async('string'), flat = (x) => x.replace(/\n/g, '');
const sha = (s) => crypto.createHash('sha512').update(s).digest('base64');
assert.ok(flat(author).includes(sha('<p>kodi</p>')), 'author signature has the digest of index.html');
assert.ok(author.includes('URI="media%2Fsplash.jpg"') || author.includes('URI="media/splash.jpg"'));
const dist = await out.file('signature1.xml').async('string');
assert.ok(flat(dist).includes(sha(author)), 'distributor signature covers the author signature');
assert.equal(await packageId(signed), 'KodiWasmTv');
console.log('ok');
