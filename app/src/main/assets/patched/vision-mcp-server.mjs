#!/usr/bin/env node
// dsh-qwen-vision — 零依赖 stdio MCP 服务器：把 Qwen-VL（多模态）暴露为文本模型的"眼睛"。
// 协议：MCP stdio（换行分隔的 JSON-RPC 2.0），只用 Node 内置模块，无第三方依赖。
//
// 工具（经 dsh-mcp-client 会以 mcp__<serverName>__<name> 暴露给模型）：
//   look        — 描述/问答一张图
//   ocr         — 提取图中全部文字
//   ground      — 定位图中目标，返回边界框坐标
//   screenshot  — 截取主屏幕（Windows）并返回临时文件路径（可继续交给 look/ocr/ground）

import readline from 'node:readline';
import { mkdirSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import os from 'node:os';

const API_KEY = process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY || process.env.OPENAI_API_KEY || '';
const BASE_URL = (process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, '');
const MODEL = process.env.DASHSCOPE_MODEL || 'qwen-vl-max';
const PROTOCOL_FALLBACK = '2024-11-05';

const SERVER_INFO = { name: 'dsh-qwen-vision', version: '1.0.0' };

function log(...args) {
  // stdout 是协议通道，日志一律走 stderr
  console.error('[vision-mcp]', ...args);
}

// ---------- DashScope 调用 ----------
// 带超时 + 指数退避重试：4xx 客户端错误立即抛（不重试），5xx/网络/超时最多重试 3 次。
async function callVLM(messages, maxTokens = 1024) {
  if (!API_KEY) throw new Error('缺少 DASHSCOPE_API_KEY 环境变量');
  const body = JSON.stringify({ model: MODEL, messages, max_tokens: maxTokens, temperature: 0 }); // 循环外构造一次，重试复用
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(60000),
      });
      if (!res.ok) {
        const text = await res.text();
        lastErr = new Error(`DashScope HTTP ${res.status}: ${text.slice(0, 600)}`);
        if (res.status >= 400 && res.status < 500) throw lastErr; // 客户端错误：不重试
        continue; // 5xx：重试
      }
      const data = await res.json(); // 直接解析，省一次 text() 拷贝
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content) {
        throw new Error('DashScope 返回结构异常: ' + JSON.stringify(data).slice(0, 400));
      }
      return content;
    } catch (e) {
      if (attempt === 2) throw e; // 最后一次：抛给上层
      lastErr = e;
      log(`callVLM 重试 ${attempt + 1}/2: ${e && e.message ? e.message : e}`);
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1))); // 指数退避
    }
  }
  throw lastErr || new Error('DashScope 调用失败');
}

// ---------- 图片输入解析（路径 / URL / data URI 自动识别）----------
const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
};

function mimeFromExt(ext) {
  return MIME_BY_EXT[(ext || '').toLowerCase()] || 'image/png';
}

// 同一文件短时间内的 base64 结果缓存（按 mtime+size 失效），
// 避免模型对同一张截图连续 look/ground/ocr 时重复读盘 + base64。
const imageCache = new Map(); // path -> { mtimeMs, size, dataUri }
const IMAGE_CACHE_MAX = 20;

async function imagePart(image) {
  if (typeof image !== 'string' || !image.trim()) throw new Error('参数 image 必填（本地路径 / http(s) URL / data URI）');
  const s = image.trim();
  if (s.startsWith('data:')) return { type: 'image_url', image_url: { url: s } };
  if (/^https?:\/\//i.test(s)) return { type: 'image_url', image_url: { url: s } };
  const p = resolve(s);
  const mime = mimeFromExt(extname(p));
  let st;
  try {
    st = await stat(p);
  } catch {
    throw new Error('图片文件不存在: ' + p);
  }
  const hit = imageCache.get(p);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
    return { type: 'image_url', image_url: { url: hit.dataUri } };
  }
  const buf = await readFile(p); // 异步读，不阻塞事件循环
  const dataUri = `data:${mime};base64,${buf.toString('base64')}`;
  imageCache.set(p, { mtimeMs: st.mtimeMs, size: st.size, dataUri });
  if (imageCache.size > IMAGE_CACHE_MAX) imageCache.clear(); // 截图临时文件会不断产生，控制内存
  return { type: 'image_url', image_url: { url: dataUri } };
}

// ---------- 工具实现 ----------
async function toolLook(args) {
  const question = (args.question && String(args.question).trim()) || '请详细描述这张图的内容。';
  const content = await callVLM([
    { role: 'user', content: [{ type: 'image_url', ...(await imagePart(args.image)) }, { type: 'text', text: question }] },
  ]);
  return content;
}

async function toolOcr(args) {
  const content = await callVLM([
    { role: 'user', content: [
      { type: 'image_url', ...(await imagePart(args.image)) },
      { type: 'text', text: '请识别图中所有文字，按从上到下、从左到右的顺序逐条输出，不要遗漏，不要翻译。若没有文字则回复"（无文字）"。' },
    ] },
  ]);
  return content;
}

async function toolGround(args) {
  const target = String(args.target || '').trim();
  if (!target) throw new Error('参数 target 必填（要定位的目标描述）');
  const content = await callVLM([
    { role: 'user', content: [
      { type: 'image_url', ...(await imagePart(args.image)) },
      { type: 'text', text: `定位图中"${target}"，只输出一个 JSON 对象：{"label":"...","bbox":[x1,y1,x2,y2],"unit":"pixel"}，其中 bbox 是该目标边界框的像素坐标。找不到就输出 {"label":"${target}","bbox":null}` },
    ] },
  ]);
  return content;
}

// ---------- 常驻 PowerShell worker（消除每次截图/点击的进程冷启动） ----------
// 一个长驻的 powershell.exe，通过 stdio 收发行分隔 JSON 命令：{"id":N,"op":"screenshot|click|ping",...}
// 响应：{"id":N,"ok":true,"result":{...}} 或 {"id":N,"ok":false,"error":"..."}
const WORKER_SCRIPT = `$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void mouse_event(uint f,uint dx,uint dy,uint c,uint e);' -Name MouseApi -Namespace W
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line -eq '') { continue }
  $id = -1
  try {
    $req = $line | ConvertFrom-Json
    $id = [int]$req.id
    $resp = @{ id = $id; ok = $true }
    $op = [string]$req.op
    if ($op -eq 'ping') {
      $resp.result = 'pong'
    } elseif ($op -eq 'screenshot') {
      $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
      $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
      $bmp.Save([string]$req.path, [System.Drawing.Imaging.ImageFormat]::Png)
      $g.Dispose(); $bmp.Dispose()
      $resp.result = @{ width = $b.Width; height = $b.Height }
    } elseif ($op -eq 'click') {
      $x = [int]$req.x; $y = [int]$req.y
      [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point($x, $y)
      Start-Sleep -Milliseconds 120
      $down = 2; $up = 4
      $btn = [string]$req.button
      if ($btn -eq 'right') { $down = 8; $up = 16 }
      elseif ($btn -eq 'middle') { $down = 32; $up = 64 }
      [W.MouseApi]::mouse_event($down, 0, 0, 0, 0)
      Start-Sleep -Milliseconds 60
      [W.MouseApi]::mouse_event($up, 0, 0, 0, 0)
      if ($req.double -eq $true) {
        Start-Sleep -Milliseconds 80
        [W.MouseApi]::mouse_event($down, 0, 0, 0, 0)
        Start-Sleep -Milliseconds 60
        [W.MouseApi]::mouse_event($up, 0, 0, 0, 0)
      }
      $resp.result = @{ clicked = $true }
    } else {
      throw ('unknown op: ' + $op)
    }
  } catch {
    $resp = @{ id = $id; ok = $false; error = $_.Exception.Message }
  }
  [Console]::Out.WriteLine(($resp | ConvertTo-Json -Compress -Depth 5))
}`;

let worker = null;
let workerReqId = 0;
const workerPending = new Map(); // id -> { resolve, reject }
let workerBuf = '';

function ensureWorker() {
  if (worker && worker.exitCode === null && !worker.killed) return worker;
  const encoded = Buffer.from(WORKER_SCRIPT, 'utf16le').toString('base64');
  const w = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  worker = w;
  workerBuf = '';
  w.stdout.setEncoding('utf8');
  w.stdout.on('data', (chunk) => {
    workerBuf += chunk;
    let idx;
    while ((idx = workerBuf.indexOf('\n')) >= 0) {
      const line = workerBuf.slice(0, idx).replace(/\r$/, '');
      workerBuf = workerBuf.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { log('worker 非法输出行:', line.slice(0, 200)); continue; }
      const p = workerPending.get(msg.id);
      if (p) {
        workerPending.delete(msg.id);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(msg.error || 'PowerShell worker 错误'));
      }
    }
  });
  w.stderr.on('data', (d) => { const s = String(d).trim(); if (s) log('[worker]', s.slice(0, 400)); });
  w.on('exit', (code) => {
    if (worker === w) worker = null;
    const err = new Error('PowerShell worker 退出 (code ' + code + ')');
    for (const p of workerPending.values()) p.reject(err);
    workerPending.clear();
  });
  w.on('error', (e) => { if (worker === w) worker = null; log('worker spawn error', e); });
  return w;
}

function workerCall(op, payload = {}, timeoutMs = 30000) {
  const w = ensureWorker();
  const id = ++workerReqId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      workerPending.delete(id);
      reject(new Error('PowerShell worker 超时: ' + op));
    }, timeoutMs);
    workerPending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    try {
      w.stdin.write(JSON.stringify({ id, op, ...payload }) + '\n');
    } catch (e) {
      clearTimeout(timer);
      workerPending.delete(id);
      reject(e);
    }
  });
}

function killWorker() {
  if (worker && worker.exitCode === null) {
    try { worker.kill(); } catch {}
  }
  worker = null;
}

let shotSeq = 0; // 截图文件名序号：worker 提速后两次截图可能同毫秒，用序号保证唯一

async function toolScreenshot(args) {
  const dir = join(os.tmpdir(), 'dsh-vision');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `shot-${Date.now()}-${shotSeq++}.png`);
  try {
    await workerCall('screenshot', { path });
  } catch (e) {
    throw new Error('截图失败: ' + String(e && e.message ? e.message : e).slice(0, 400));
  }
  let out = JSON.stringify({ path, hint: '这是刚截取的屏幕，可以用 look/ocr/ground 继续分析它' });
  if (args.question && String(args.question).trim()) {
    try {
      const desc = await toolLook({ image: path, question: args.question });
      out = JSON.stringify({ path, answer: desc });
    } catch (e) {
      out = JSON.stringify({ path, error: String(e) });
    }
  }
  return out;
}

async function toolClick(args) {
  const x = Math.round(Number(args.x));
  const y = Math.round(Number(args.y));
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('x/y 必须是数字');
  const button = String(args.button || 'left').toLowerCase();
  const double = !!args.double;
  // 入参 (x,y) 是【逻辑像素】（与 screenshot/ground 同坐标系），
  // 常驻 worker 内部点击，系统自动完成 DPI 逻辑→物理映射。
  await workerCall('click', { x, y, button, double });
  return JSON.stringify({ clicked: true, logical: [x, y], button, double });
}

// ---------- 工具清单 ----------
const TOOLS = [
  {
    name: 'look',
    description: '看图：描述图片内容或回答关于图片的问题。image 可填本地绝对路径、http(s) URL 或 base64 data URI。',
    inputSchema: {
      type: 'object',
      properties: {
        image: { type: 'string', description: '图片：本地绝对路径 / http(s) URL / base64 data URI' },
        question: { type: 'string', description: '关于图片的问题（可选，默认整体描述）' },
      },
      required: ['image'],
    },
  },
  {
    name: 'ocr',
    description: '文字识别：提取图片中的全部文字。适合截图、文档、UI 界面。',
    inputSchema: {
      type: 'object',
      properties: {
        image: { type: 'string', description: '图片：本地绝对路径 / http(s) URL / base64 data URI' },
      },
      required: ['image'],
    },
  },
  {
    name: 'ground',
    description: '定位：找出图片中指定目标（如某个按钮/图标/物体）并返回像素边界框坐标，用于"在屏幕上找到它"。',
    inputSchema: {
      type: 'object',
      properties: {
        image: { type: 'string', description: '图片：本地绝对路径 / http(s) URL / base64 data URI' },
        target: { type: 'string', description: '要定位的目标描述，例如"登录按钮"、"搜索框"、"那只狗"' },
      },
      required: ['image', 'target'],
    },
  },
  {
    name: 'screenshot',
    description: '截取 Windows 主屏幕，返回截图临时文件路径（可再交给 look/ocr/ground 分析）；带 question 时顺带给出回答。',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '可选：截图后要问的问题' },
      },
    },
  },
  {
    name: 'click',
    description: '鼠标操作：移动光标到屏幕坐标 (x,y) 并左键点击。坐标为【逻辑像素】，与 screenshot/ground 同一坐标系（系统自动处理 DPI 缩放）。',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X 坐标（逻辑像素，与截图一致）' },
        y: { type: 'number', description: 'Y 坐标（逻辑像素，与截图一致）' },
        button: { type: 'string', description: 'left / right / middle，默认 left' },
        double: { type: 'boolean', description: '是否双击，默认 false' },
      },
      required: ['x', 'y'],
    },
  },
];

const HANDLERS = { look: toolLook, ocr: toolOcr, ground: toolGround, screenshot: toolScreenshot, click: toolClick };

// ---------- stdio JSON-RPC ----------
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function handleRequest(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion || PROTOCOL_FALLBACK;
      return {
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: requested,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions: 'Qwen-VL 视觉工具：look / ocr / ground / screenshot',
        },
      };
    }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments || {};
      const handler = HANDLERS[name];
      if (!handler) {
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `未知工具: ${name}` }], isError: true } };
      }
      try {
        const text = await handler(args);
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } };
      } catch (e) {
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(e && e.message ? e.message : e) }], isError: true } };
      }
    }
    default: {
      // 通知（无 id）忽略；带 id 的未知方法回错误
      if (id === undefined || id === null) return null;
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } };
    }
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let inflight = 0;

rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { log('bad json line'); return; }
  // 仅处理请求/通知（有 method 的）；我们不会主动发请求
  if (msg && typeof msg.method === 'string') {
    inflight++;
    Promise.resolve(handleRequest(msg)).then((resp) => {
      if (resp) send(resp);
    }).catch((e) => {
      log('handler error', e);
      if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(e && e.message ? e.message : e) } });
    }).finally(() => { inflight--; });
  }
});

// 优雅退出：等 in-flight 请求排空（最多 120s），避免关 stdin 时掐断正在进行的模型调用
function drainThenExit() {
  const deadline = Date.now() + 120000;
  const timer = setInterval(() => {
    if (inflight === 0 || Date.now() > deadline) {
      clearInterval(timer);
      killWorker();
      process.exit(0);
    }
  }, 40);
  timer.unref?.();
}
process.stdin.on('end', drainThenExit);
process.on('SIGTERM', drainThenExit);

log(`ready; model=${MODEL} base=${BASE_URL} key=${API_KEY ? 'set' : 'MISSING'}`);
