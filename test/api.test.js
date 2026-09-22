'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// 只在本文件需要时惰性启动服务（端口 0 = 系统分配），避免与其他测试文件的进程互相干扰
let server;
let baseUrl;

test.before(async () => {
  const app = require('../server');
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  const addr = server.address();
  baseUrl = 'http://127.0.0.1:' + addr.port;
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
});

function postJson(path, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request(baseUrl + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(data) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('POST /api/panel 成功拼版：返回标签索引/旋转角/全局点/SVG', async () => {
  const res = await postJson('/api/panel', {
    labels: 'EXIT\nWOMEN\nMEN',
    plateWidth: 120, plateHeight: 80
  });
  assert.equal(res.status, 200);
  const r = res.json;
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'panel');
  assert.equal(r.labelCount, 3);
  assert.deepEqual(r.labels.map(l => l.index), [1, 2, 3]);
  assert.ok(r.labels.every(l => l.rotation === 0 || l.rotation === 90));
  assert.ok(r.dots.length > 0);
  assert.match(r.svg, /<svg /);
  assert.match(r.svg, /data-label-index="1"/);
});

test('POST /api/panel labels 支持数组；放不下时 ok=false 且无部分版面', async () => {
  const ok = await postJson('/api/panel', { labels: ['ab', 'cd'], plateWidth: 120, plateHeight: 80 });
  assert.equal(ok.json.ok, true);
  assert.equal(ok.json.labelCount, 2);

  const fail = await postJson('/api/panel', { labels: ['bbcdefghijklmno'], plateWidth: 90, plateHeight: 60 });
  assert.equal(fail.json.ok, false);
  assert.equal(fail.json.svg, null);
  assert.equal(fail.json.dots.length, 0);
  assert.ok(fail.json.errors.some(e => e.labelIndex === 1));
});

test('POST /api/layout 单标签接口行为不变（向后兼容）', async () => {
  const r = await postJson('/api/layout', { text: 'ab', plateWidth: 100, plateHeight: 50 });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.dots.length > 0, true);
  assert.doesNotMatch(r.json.svg, /data-label-index/);
});

test('POST /api/qc 质检接口可直接消费拼版结果的顶层 dots（接口兼容）', async () => {
  const panel = await postJson('/api/panel', { labels: 'a\nb', plateWidth: 120, plateHeight: 80 });
  assert.equal(panel.json.ok, true);
  const qc = await postJson('/api/qc', {
    design: panel.json.dots,
    csv: panel.json.dots.map(d => d.x + ',' + d.y).join('\n'),
    tolerance: 0.5,
    maxRadius: 2,
    plateWidth: 120,
    plateHeight: 80
  });
  assert.equal(qc.json.ok, true);
  assert.equal(qc.json.stats.missingCount, 0);
  assert.equal(qc.json.stats.extraCount, 0);
  assert.equal(qc.json.stats.passCount, panel.json.dots.length);
});

test('POST /api/qc 以拼版为基准：配对/报告/叠加图标注标签索引与旋转角', async () => {
  // 短标签 0° + 长标签只能 90°：一次拼版同时覆盖两种旋转角
  const panel = await postJson('/api/panel', {
    labels: 'EXIT\nbbcdefghijklmno', plateWidth: 95, plateHeight: 100
  });
  assert.equal(panel.json.ok, true);
  assert.deepEqual(panel.json.labels.map(l => l.rotation), [0, 90]);
  const dots = panel.json.dots;
  assert.ok(dots.every(d => Number.isInteger(d.label) && (d.rotation === 0 || d.rotation === 90)));

  const qc = await postJson('/api/qc', {
    design: dots,
    csv: dots.map(d => d.x + ',' + d.y).join('\n'),
    tolerance: 0.2,
    maxRadius: 1,
    plateWidth: 95,
    plateHeight: 100
  });
  assert.equal(qc.json.ok, true);
  assert.equal(qc.json.stats.passCount, dots.length);
  // 配对结果保留标签元数据
  assert.ok(qc.json.pairs.every(p => p.label === 1 || p.label === 2));
  assert.ok(qc.json.pairs.some(p => p.labelRotation === 90));
  // CSV 报告：标签列 + 标签清单（含 0° 与 90° 两条）
  assert.match(qc.json.csv, /design_index,label_index,label_rotation_deg,design_x_mm/);
  assert.match(qc.json.csv, /# labels,label_index,label_rotation_deg,design_dots/);
  assert.match(qc.json.csv, /^,1,0,\d+$/m);
  assert.match(qc.json.csv, /^,2,90,\d+$/m);
  // 叠加 SVG：标签锚点与 data-label 属性
  assert.match(qc.json.svg, /data-label="1"/);
  assert.match(qc.json.svg, /data-label-rotation="90"/);
  assert.match(qc.json.svg, />#1</);
  assert.match(qc.json.svg, />#2 ⟳90°</);
});

test('GET /api/health 健康检查正常', async () => {
  const r = await new Promise((resolve, reject) => {
    http.get(baseUrl + '/api/health', res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(data) }));
    }).on('error', reject);
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'ok');
});

test('静态资源：/lib/panel.js 与首页可访问', async () => {
  const fetchText = path => new Promise((resolve, reject) => {
    http.get(baseUrl + path, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
  const lib = await fetchText('/lib/panel.js');
  assert.equal(lib.status, 200);
  assert.match(lib.body, /packLabels/);
  const page = await fetchText('/');
  assert.equal(page.status, 200);
  assert.match(page.body, /tabPanel/);
  assert.match(page.body, /多标签拼版/);
});
