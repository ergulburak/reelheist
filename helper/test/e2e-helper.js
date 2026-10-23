'use strict';
// Manual end-to-end check: talk to host.js like the browser does, then run a short job.
// Usage: node test/e2e-helper.js <jobs.json> <outDir>
// jobs.json: [{ meta, source: {url, headers, kind}, subtitles, maxSegments }]

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

function nativeHello() {
  return new Promise((resolve, reject) => {
    const p = spawn('cmd.exe', ['/c', path.join(__dirname, '..', 'host.bat')], { stdio: ['pipe', 'pipe', 'inherit'] });
    const msg = Buffer.from(JSON.stringify({ cmd: 'hello' }));
    const len = Buffer.alloc(4);
    len.writeUInt32LE(msg.length);
    p.stdin.end(Buffer.concat([len, msg]));
    let out = Buffer.alloc(0);
    p.stdout.on('data', d => (out = Buffer.concat([out, d])));
    p.on('close', () => {
      if (out.length < 4) return reject(new Error('no reply'));
      resolve(JSON.parse(out.subarray(4, 4 + out.readUInt32LE(0)).toString()));
    });
  });
}

(async () => {
  const [jobsFile, outDir] = process.argv.slice(2);
  const t0 = Date.now();
  const info = await nativeHello();
  console.log('host reply', { ...info, token: info.token ? '***' : undefined }, `${Date.now() - t0} ms`);
  if (!info.ok) process.exit(1);
  const api = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${info.port}/api${p}`, {
      method,
      headers: { 'X-Token': info.token, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return r.json();
  };
  console.log('ping', await api('GET', '/ping'));
  const jobs = JSON.parse(fs.readFileSync(jobsFile, 'utf8'));
  for (const j of jobs) {
    console.log("probe", JSON.stringify(await api("POST", "/probe", j.source)).slice(0, 400));
  }
  const { ids } = await api('POST', '/jobs', { jobs: jobs.map(j => ({ ...j, outDir })) });
  console.log('added', ids);
  for (;;) {
    await new Promise(r => setTimeout(r, 2000));
    const { jobs: all } = await api('GET', '/jobs');
    const mine = all.filter(j => ids.includes(j.id));
    console.log(mine.map(j => `${j.names.base}: ${j.state} ${j.progress ? Math.round(j.progress.percent || 0) + '% ' + j.progress.phase : ''} ${j.error || ''}`).join(' | '));
    if (mine.every(j => ['done', 'failed', 'canceled'].includes(j.state))) {
      for (const j of mine) console.log(JSON.stringify(j.output, null, 1));
      break;
    }
  }
})();
