/**
 * loon-harvest.js —— Loon 凭证采集器（手机 App → 青龙）
 * ============================================================
 * v1.4 ｜ 2026-11-06 ｜ 凭据走 Loon argument，文件本身可公开
 *
 * 为什么叫 harvest：这一个脚本把**所有只能在手机上拿到**的凭证
 * 统一采集、统一推青龙。以后哪个脚本缺东西，只改下面 PLATFORMS 表 + 加一个
 * handler 函数，不用再新建文件、不用再改 Loon 配置（hosts 已全列好）。
 *
 * ── 现在能采的 ──────────────────────────────────────────────
 *   京东      JD_COOKIE / JD_WSKEY     pt_key·light_key·pt_pin·wskey
 *   淘宝闪购  TB_LUCKYSTAR_ACCOUNTS    cookie（unb 做标识）
 *             MD_UMT                   ★ x-umt 设备头（幸运星领奖必须）
 *   闲鱼      XIANYU_COOKIE            cookie（unb 做标识）
 *   联通      chinaUnicomCookie        token + appId + 手机号
 *   值得买    SMZDM_COOKIE             cookie
 *
 * ── 采不到的（别指望这个脚本）────────────────────────────────
 *   电信 / 高德 / 移动话费 / 移动云盘 —— 这些是「手机号+服务密码」登录，
 *   不是 cookie，抓不到。继续走 ActivityHub 面板登录。
 *
 * ── 设计原则 ────────────────────────────────────────────────
 *   ① 每个平台独立 try/catch，一个挂了不影响别的
 *   ② 只写**有变化**的变量，没变就不碰（省请求、少风控）
 *   ③ 写完一律回读校验，不信「保存成功」
 *   ④ 合并策略：凭证键覆盖、指纹键保留（京东那个 38 键的教训）
 *   ⑤ 同一身份 30 分钟冷却，防刷
 *
 * ============================================================
 * Loon 配置
 * ============================================================
 * 规则和 MITM 的具体写法**不在这里重复** —— 配套的 loon-harvest-订阅版.conf
 * 才是唯一准的版本（这里抄一份早晚会不同步）。
 *
 * 各平台要留意的点：
 *   京东       requires-body=false
 *   淘宝       requires-body=false
 *   闲鱼       requires-body=false
 *   联通       requires-body=**true**   ← appId 在 POST 表单体里，false 拿不到
 *   值得买     requires-body=false
 *   全部 5 条都要带 argument=（凭据），否则鉴权失败
 */

/*
 * ── 凭据从 Loon 的脚本参数读，不写死在文件里 ──────────────────────
 * 这样本文件可以放到公开仓库/订阅，谁看到都无所谓。
 * 凭据写在你自己的 Loon 配置 [Script] 规则的 argument= 里：
 *
 *   argument=panel=http://你的青龙服务器IP:5711&cid=你的client_id&secret=你的client_secret
 *
 * 也支持 JSON：argument={"panel":"...","cid":"...","secret":"..."}
 * 没配的话取票会失败，通知里会明确提示「没配 cid/secret」。
 */
function readArgument() {
  let raw = '';
  try { raw = (typeof $argument !== 'undefined' && $argument) ? String($argument) : ''; } catch (e) { raw = ''; }
  const out = {};
  const s = String(raw || '').trim();
  if (!s) return out;
  if (s.charAt(0) === '{') {
    try {
      const j = JSON.parse(s);
      Object.keys(j || {}).forEach(function (k) { out[k] = j[k]; });
      return out;
    } catch (e) { return out; }
  }
  s.split('&').forEach(function (kv) {
    const i = kv.indexOf('=');
    if (i > 0) {
      const k = kv.slice(0, i).trim();
      let v = kv.slice(i + 1).trim();
      try { v = decodeURIComponent(v); } catch (e) { /* keep */ }
      if (k) out[k] = v;
    }
  });
  return out;
}

const ARG = readArgument();

const CFG = {
  version: 'harvest-1.4',

  /* 青龙面板 —— 手机要和服务器同一局域网（京东 Mesh 后面也能通，走 NAT） */
  panel: ARG.panel || ARG.PANEL || '',   /* 必填 —— 不把服务器地址写死在公开代码里 */
  clientId: ARG.cid || ARG.clientId || ARG.CID || '',
  clientSecret: ARG.secret || ARG.clientSecret || ARG.SECRET || '',

  /* 触发哪个青龙任务（0 = 不触发） */
  cron: {
    jdSync: 172,        // 京东Cookie同步（补指纹）
    jdConvert: 180,     // 京东-Wskey换CK
  },

  /* ★ 2026-11-10 v6：设备指纹的「配置兜底」。
     抓包能拿到就用抓到的（新鲜），拿不到就用这里写的（一劳永逸，不用每次重抓）。
     由 .lcf 的 argument 传进来：jduuid / jdeid / jdbrand / jdmodel / jdos / jdbuild / jdclient
     UA 不传，脚本用上面几个字段自动拼成 jdapp; 格式。 */
  jdDev: {
    uuid:   String(ARG.jduuid   || ARG.JDUUID   || '').trim(),
    eid:    String(ARG.jdeid    || ARG.JDEID    || '').trim(),
    wg:     String(ARG.jdwg     || ARG.JDWG     || '').trim(),
    brand:  String(ARG.jdbrand  || ARG.JDBRAND  || '').trim(),
    model:  String(ARG.jdmodel  || ARG.JDMODEL  || '').trim(),
    os:     String(ARG.jdos     || ARG.JDOS     || '').trim(),
    build:  String(ARG.jdbuild  || ARG.JDBUILD  || '').trim(),
    client: String(ARG.jdclient || ARG.JDCLIENT || '').trim(),
  },

  pushCooldown: 30 * 60 * 1000,   // 同一身份 30 分钟内不重复写
  tokenTTL: 20 * 60 * 1000,       // 青龙 token 本地缓存
  timeout: 15000,                 // 单次 HTTP 超时，绝不静默挂住
  debug: /^(1|true|yes|on)$/i.test(String(ARG.debug || ARG.DEBUG || '')),
};

const NOW = Date.now();

/* ============================================================
 * 配置版本自检 —— 防止「脚本更新了但配置没重贴」
 *
 * 配置的 argument= 里要带 cfgv=N。改了域名清单 / 参数结构就 +1。
 * 不一致只提醒，不阻断采集（旧配置多半还能用）。
 * 提醒 6 小时内只发一次，免得每次开 App 都弹。
 * ============================================================ */
const CFG_VER = 5;
function checkCfgVersion() {
  const got = parseInt(ARG.cfgv || ARG.CFGV || '0', 10) || 0;
  if (got >= CFG_VER) return;
  const K = 'cfgwarn_ts';
  const last = parseInt(prefGet(K, '0') || '0', 10) || 0;
  if (NOW - last < 6 * 3600 * 1000) return;
  prefSet(K, String(NOW));
  const detail = got === 0
    ? '你的配置是老版本（没有 cfgv 标记），可能缺新域名或新参数'
    : '你的配置 cfgv=' + got + '，当前需要 ' + CFG_VER;
  log('cfg-version | 需要 ' + CFG_VER + '，实际 ' + got + ' | 提醒更新配置');
  try {
    $notification.post('采集器配置该更新了', detail,
      '找 AI 要新的 Loon 配置，重贴 [Script] 和 [Mitm] 两段');
  } catch (e) { /* 通知失败不影响采集 */ }
}


/* ============================================================
 * 平台表 —— 以后加平台只改这里
 * ============================================================ */
const PLATFORMS = [
  {
    id: 'jd',
    name: '京东',
    hosts: ['sh.jd.com', 'item.m.jd.com', 'api.m.jd.com', 'plogin.m.jd.com'],
    handle: handleJd,
  },
  {
    id: 'taobao',
    name: '淘宝/闪购',
    hosts: ['h5api.m.taobao.com', 'waimai-guide.ele.me', 'shopping.ele.me',
            'alsc-buy2.ele.me', 'tb.ele.me', 'h5.ele.me'],
    handle: handleTaobao,
  },
  {
    id: 'xianyu',
    name: '闲鱼',
    hosts: ['h5api.m.goofish.com', 'www.goofish.com', 'h5.m.goofish.com'],
    handle: handleXianyu,
  },
  {
    id: 'unicom',
    name: '联通',
    hosts: ['m.client.10010.com', 'loginxhm.10010.com'],
    handle: handleUnicom,
  },
  {
    id: 'smzdm',
    name: '值得买',
    hosts: ['h5.smzdm.com', 'user-api.smzdm.com', 'post.smzdm.com', 'm.smzdm.com'],
    handle: handleSmzdm,
  },
];

/*
 * 会过期的凭证键 —— 抓到就覆盖；其余（指纹）只在原来没有时补进来。
 *
 * 这条规则**只给京东用**（它的 38 个指纹键一个字都不能丢）。
 * 淘宝 / 闲鱼 / 值得买是「整串 cookie 就是凭证」，走 mergeCookiePreferNew（新值优先），
 * 因为那里的 _tb_token_ / cookie2 / _m_h5_tk / sess 全都会轮换。
 */
const CRED_KEYS = ['pt_key', 'pt_pin', 'light_key', 'wskey', 'pwdt_id', 'sfstoken',
                   'key', 'pin', 'pinId', 'thor', 'token', 'thorToken'];

/* ============================================================
 * 基础工具
 * ============================================================ */

const reqHeaders = (typeof $request !== 'undefined' && $request && $request.headers) || {};
const respHeaders = (typeof $response !== 'undefined' && $response && $response.headers) || {};
const reqUrl = (typeof $request !== 'undefined' && $request && $request.url) || '';
const reqBody = (typeof $request !== 'undefined' && $request && $request.body) || '';

/* 京东自家测试账号，抓进来会污染真实 pin（unitRouterTest 那一套） */
const PIN_BLACKLIST = /routertest|^unit|^test|^demo$|^null$|^undefined$|^jd_test/i;

function validPin(p) {
  if (!p) return false;
  if (PIN_BLACKLIST.test(p)) return false;
  return /^[A-Za-z0-9_\-@.]{3,64}$/.test(p);
}

function log(msg) { console.log('[采集] ' + CFG.version + ' | ' + msg); }
function dbg(msg) { if (CFG.debug) console.log('[采集][debug] ' + msg); }

/* 大小写不敏感取头 */
function getHeader(h, name) {
  if (!h) return '';
  const t = String(name).toLowerCase();
  for (const k in h) {
    if (String(k).toLowerCase() === t) return h[k];
  }
  return '';
}

/* "k=v; k2=v2" → {k:v, k2:v2} */
function parseCookie(s) {
  const out = {};
  String(s || '').split(';').forEach(function (kv) {
    const i = kv.indexOf('=');
    if (i > 0) {
      const k = kv.slice(0, i).trim();
      const v = kv.slice(i + 1).trim();
      if (k) out[k] = v;
    }
  });
  return out;
}

/*
 * set-cookie 有三种形态，都要吃得下：
 *   ① 数组：['a=1; Path=/', 'b=2; Path=/']
 *   ② 单个字符串：'a=1; Path=/'
 *   ③ 多个合并成一个字符串：'a=1; Path=/, b=2; Path=/'  ← Loon 常见
 * 形态③如果只 split(';')[0]，会把 b 整条丢掉。
 * 判据：逗号后面紧跟「token=」才当分隔符（Expires 里的逗号后面是空格+日期，不会误切）。
 */
function parseSetCookie(raw) {
  const out = {};
  let arr = [];
  if (Array.isArray(raw)) {
    arr = raw;
  } else if (raw) {
    const str = String(raw);
    arr = str.indexOf(',') >= 0 && /,\s*[A-Za-z0-9_\-]+=/.test(str) ? str.split(/,(?=\s*[A-Za-z0-9_\-]+=)/) : [str];
  }
  arr.forEach(function (line) {
    const first = String(line).split(';')[0];
    const i = first.indexOf('=');
    if (i > 0) {
      const k = first.slice(0, i).trim();
      const v = first.slice(i + 1).trim();
      if (k && v && v !== 'delete') out[k] = v;
    }
  });
  return out;
}

function serializeCookie(obj) {
  return Object.keys(obj).map(function (k) { return k + '=' + obj[k]; }).join(';');
}

/* 采集上下文：请求 cookie + 响应 set-cookie 合并（响应优先，那是刚下发的） */
function collectCookie() {
  const a = parseCookie(getHeader(reqHeaders, 'cookie'));
  const b = parseSetCookie(getHeader(respHeaders, 'set-cookie'));
  const out = {};
  Object.keys(a).forEach(function (k) { out[k] = a[k]; });
  Object.keys(b).forEach(function (k) { out[k] = b[k]; });
  dbg('cookie: 请求 ' + Object.keys(a).length + ' 键 + set-cookie ' + Object.keys(b).length + ' 键');
  return out;
}

function hostOf(url) {
  const m = String(url || '').match(/^https?:\/\/([^/?#]+)/i);
  return m ? m[1].toLowerCase() : '';
}

function queryOf(url, name) {
  const m = String(url || '').match(new RegExp('[?&]' + name + '=([^&#]*)', 'i'));
  if (!m) return '';
  try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
}

/* 联通把 appId 放在 POST 表单体里，不在 query —— 两边都要找。
   对应的 Loon 配置那条必须 requires-body=true，否则 body 拿不到。 */
function paramOf(url, body, name) {
  const q = queryOf(url, name);
  if (q) return q;
  const m = String(body || '').match(new RegExp('(?:^|&)' + name + '=([^&]*)', 'i'));
  if (!m) return '';
  try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
}

/* Loon 本地存储 */
function prefGet(k, d) {
  let v = null;
  try {
    v = (typeof $persistentStore !== 'undefined' && $persistentStore) ? $persistentStore.read(k) : null;
  } catch (e) { v = null; }
  return (v === null || v === undefined || v === '') ? d : v;
}
function prefSet(k, v) {
  try {
    if (typeof $persistentStore !== 'undefined' && $persistentStore) {
      $persistentStore.write(String(v), k);
    }
  } catch (e) { /* ignore */ }
}

function notify(title, sub, body) {
  try {
    if (typeof $notification !== 'undefined' && $notification && $notification.post) {
      $notification.post(String(title), String(sub), String(body));
    }
  } catch (e) { /* ignore */ }
}

/* HTTP：$task.fetch 优先（支持任意 method），退路 $httpClient.<method>，一定带超时 */
function http(opts) {
  return new Promise(function (resolve, reject) {
    let settled = false;
    const timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      reject(new Error('请求超时 ' + CFG.timeout + 'ms'));
    }, CFG.timeout);

    function ok(v) { if (settled) return; settled = true; clearTimeout(timer); resolve(v); }
    function no(e) { if (settled) return; settled = true; clearTimeout(timer); reject(e); }

    const method = String(opts.method || 'GET').toUpperCase();
    try {
      if (typeof $task !== 'undefined' && $task && $task.fetch) {
        $task.fetch({ url: opts.url, method: method, headers: opts.headers || {}, body: opts.body || undefined })
          .then(function (r) { ok({ status: r.statusCode || r.status || 0, body: r.body || '' }); },
                function (e) { no(new Error('网络失败: ' + (e && e.error ? e.error : e))); });
        return;
      }
      if (typeof $httpClient !== 'undefined' && $httpClient) {
        const fn = $httpClient[method.toLowerCase()] || $httpClient.get;
        fn({ url: opts.url, headers: opts.headers || {}, body: opts.body || undefined },
          function (err, resp, body) {
            if (err) return no(new Error('网络失败: ' + err));
            ok({ status: (resp && (resp.status || resp.statusCode)) || 0, body: body || '' });
          });
        return;
      }
      no(new Error('Loon 无可用 HTTP 客户端'));
    } catch (e) {
      no(new Error('请求异常: ' + (e && e.message ? e.message : e)));
    }
  });
}

function parseJson(body, what) {
  let j = null;
  try { j = JSON.parse(body); } catch (e) { /* ignore */ }
  if (!j) throw new Error(what + '返回非 JSON: ' + String(body).slice(0, 70));
  return j;
}

/* ============================================================
 * 青龙 API
 * ============================================================ */

function getToken() {
  const cached = prefGet('ql_tok', '');
  const exp = Number(prefGet('ql_tok_exp', 0));
  if (cached && exp > NOW) return Promise.resolve(cached);

  if (!CFG.panel) {
    return Promise.reject(new Error('没配 panel —— 去 Loon 配置 [Script] 规则的 argument= 里填 panel=http://你的服务器:5711'));
  }
  const u = CFG.panel + '/open/auth/token?client_id=' +
    encodeURIComponent(CFG.clientId) + '&client_secret=' + encodeURIComponent(CFG.clientSecret);

  return http({ url: u, method: 'GET' }).then(function (r) {
    const j = parseJson(r.body, '取票');
    if (!j.data || !j.data.token) {
      const hint = (!CFG.clientId || !CFG.clientSecret)
        ? '（没配 cid/secret —— 去 Loon 配置 [Script] 规则的 argument= 里填）'
        : '';
      throw new Error('鉴权失败 HTTP ' + r.status + hint + ' ' + String(r.body).slice(0, 60));
    }
    prefSet('ql_tok', j.data.token);
    prefSet('ql_tok_exp', NOW + CFG.tokenTTL);
    return j.data.token;
  });
}

function getEnvs(tok) {
  return http({
    url: CFG.panel + '/open/envs', method: 'GET',
    headers: { Authorization: 'Bearer ' + tok },
  }).then(function (r) {
    const j = parseJson(r.body, '读变量');
    if (j.code !== 200 || !Array.isArray(j.data)) {
      throw new Error('读变量失败 ' + String(r.body).slice(0, 70));
    }
    return j.data;
  });
}

function findEnv(envs, name) {
  for (let i = 0; i < envs.length; i++) {
    if (envs[i].name === name) return envs[i];
  }
  return null;
}

function putEnv(tok, rec, value) {
  /* 青龙 2.24 的 PUT /open/envs 只收 id/name/value/remarks，多传 timestamp/log_path 会 400 */
  return http({
    url: CFG.panel + '/open/envs', method: 'PUT',
    headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: rec.id, name: rec.name, value: value,
      remarks: rec.remarks || 'Loon 采集器直推',
    }),
  }).then(function (r) {
    const j = parseJson(r.body, '写变量');
    if (j.code !== 200) throw new Error('写变量失败 ' + String(r.body).slice(0, 70));
    return true;
  });
}

function runCron(tok, id) {
  if (!id) return Promise.resolve(false);
  return http({
    url: CFG.panel + '/open/crons/run', method: 'PUT',
    headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
    body: JSON.stringify([id]),
  }).then(function (r) {
    const j = parseJson(r.body, '触发任务');
    return j.code === 200;
  }).catch(function () { return false; });
}

/* ============================================================
 * 行编辑：所有 env 都是「一行一个账号」的形态
 * ============================================================ */

/*
 * "pin#payload\npin2#payload2" → [{pin, cookie}]
 * ⚠️ 必须丢掉**不含 # 的行**：青龙不允许空变量，初始化时得放个占位值
 *    （「待Loon写入」之类），那种行不是真账号。不丢的话 upsertRow 会当成
 *    一个 pin 保留下来，结果是「占位行 + 真账号」两行并存，脚本解析必崩。
 *    所有行格式变量的格式都含 #（pin#cookie / 标识#cookie / token#appid#手机号），
 *    所以这条过滤是安全的。
 */
/* ★ 2026-11-11 修：原来 `s.indexOf('#') > 0` 只认 pin#cookie，
 * 遇到「完整格式」（pt_key=…;pt_pin=xxx;User-Agent=…，没有 # 前缀）会**整行丢弃** →
 * splitLines 返回空 → upsertRow 只 push 一行 → joinLines 把整个变量重写成 1 个号。
 * 实测后果：JD_COOKIE 2 个号被冲成 1 个（丢了 jd_gRIbMNmiwoGv）。
 * 现在两种格式都认：有 # 走老路，没有就从 pt_pin= 取 pin。 */
function splitLines(value) {
  return String(value || '').split('\n').map(function (s) { return s.trim(); })
    .filter(function (s) { return s && (s.indexOf('#') > 0 || /(?:^|;)\s*pt_pin=/.test(s)); })
    .map(function (line) {
      const i = line.indexOf('#');
      if (i > 0) return { pin: line.slice(0, i).trim(), cookie: line.slice(i + 1).trim() };
      const m = /(?:^|;)\s*pt_pin=([^;]+)/.exec(line);
      return { pin: m ? m[1].trim() : '', cookie: line };
    });
}

function joinLines(rows) {
  return rows.map(function (r) { return r.cookie ? (r.pin + '#' + r.cookie) : r.pin; }).join('\n');
}

/* 换掉 pin 那一行的 payload；没有就追加 */
function upsertRow(value, pin, payload) {
  const rows = splitLines(value);
  let hit = null;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].pin === pin) { hit = rows[i]; break; }
  }
  if (hit) hit.cookie = payload;
  else rows.push({ pin: pin, cookie: payload });
  return joinLines(rows);
}

/*
 * 按键合并：以已有 cookie 为底，只把凭证键盖上去。
 * 京东那 38 个指纹键（3AB9D23F7A4B3C9B / __jdv / ipLoc-djd …）一个都不能丢，
 * 丢了京东盾立刻拦。所以绝不能整串覆盖。
 */
function mergeCookie(existing, incoming) {
  if (!existing) return serializeCookie(incoming);
  const base = parseCookie(existing);
  Object.keys(incoming).forEach(function (k) {
    if (CRED_KEYS.indexOf(k) >= 0 || !(k in base)) base[k] = incoming[k];
  });
  return serializeCookie(base);
}

/* 极简 hash（FNV-1a 32 位），只用来做「票变了没」的指纹，不做安全用途 */
function shortHash(str) {
  let h = 0x811c9dc5;
  const t = String(str || '');
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16);
}

/*
 * 「新值优先」合并：旧的只用来**补齐**新值没带的键，新值全部覆盖。
 *
 * 为什么需要它：`mergeCookie` 是「指纹键保留」，对京东正确（38 个指纹键不能丢），
 * 但对**纯 cookie 类**变量（值得买的 SMZDM_COOKIE）是错的 —— 那里 sess/user
 * 本身就是凭证，必须被新值覆盖。用错策略的结果是「新票写不进去，永远是旧票」。
 */
function mergeCookiePreferNew(existing, incoming) {
  const base = parseCookie(existing || '');
  const out = {};
  Object.keys(base).forEach(function (k) { out[k] = base[k]; });
  Object.keys(incoming).forEach(function (k) { out[k] = incoming[k]; });
  return serializeCookie(out);
}

function countKeys(s) {
  return String(s || '').split(';').filter(function (x) { return x.indexOf('=') > 0; }).length;
}

/* ============================================================
 * 各平台 handler
 * 每个返回 [{ env, pin, build(oldValue) -> newValue|null, cron, note }]
 * ============================================================ */

/* ── 京东 ─────────────────────────────────────────────── */
function handleJd(ctx) {
  /* ★ 2026-11-10 诊断（放在最前面，任何 early-return 之前都会写）：
     把 api.m.jd.com 上带的请求头名字记到 JD_HEADERS（只记名字，不含值）。
     有了它就能判断：是「规则没触发」还是「头里没有 eid/wg」。 */
  const _probe = (function () {
    try {
      const names = Object.keys(reqHeaders || {}).map(function (k) { return String(k).toLowerCase(); }).sort();
      if (!names.length) return [];
      const v = names.join(',');
      const url = String(ctx.url || '').slice(0, 60);
      return [{
        env: 'JD_HEADERS', pin: '_', cron: 0, note: '头名诊断',
        build: function (old) {
          const cur = String(old || '').trim();
          if (cur === v) return null;
          return v;
        },
      }];
    } catch (e) { return []; }
  })();

  const ck = ctx.cookie;
  const pin = ck['pt_pin'] || '';
  const ptKey = ck['pt_key'] || ck['light_key'] || '';
  const wskey = ck['wskey'] || '';
  if (!validPin(pin)) {
    /* 说清楚是「挡掉了」而不是「没抓到」，不然排查时一头雾水 */
    if (pin) log('jd | pin 被黑名单/格式挡掉：' + pin + '（京东测试账号会污染真实 pin）');
    return _probe;
  }
  if (!ptKey && !wskey) return _probe;

  const jobs = [];
  if (ptKey) {
    jobs.push({
      env: 'JD_COOKIE', pin: pin, cron: CFG.cron.jdSync,
      note: 'cookie',
      build: function (old) {
        const rows = splitLines(old);
        let hit = null;
        for (let i = 0; i < rows.length; i++) if (rows[i].pin === pin) { hit = rows[i]; break; }
        const merged = hit ? mergeCookie(hit.cookie, ck) : serializeCookie(ck);
        return upsertRow(old, pin, merged);
      },
    });
  }
  if (wskey) {
    jobs.push({
      env: 'JD_WSKEY', pin: pin,
      /* 只有 wskey 时走换 CK；有 pt_key 就不必再烧一次 genToken */
      cron: ptKey ? 0 : CFG.cron.jdConvert,
      note: 'wskey',
      build: function (old) { return upsertRow(old, pin, wskey); },
    });
  }

  /* ③ JD_DEVICE —— 手机端 App 的设备指纹（2026-11-10 加）
   *
   * 为什么需要：新版京东活动脚本（JDOOOK 那套）要求 JD_COOKIE 里带
   *   user_agent / uuid / x-api-eid-token / wg-sdk-token / d_brand / d_model /
   *   osVersion / build / clientVersion —— 缺一项就跳过账号。
   * 这些**只能从 api.m.jd.com 的请求头拿到**，网页版 Cookie 里没有。
   *
   * 为什么不直接写进 JD_COOKIE：任务 172（sync_jd_cookie.py）按 `pin#cookie`
   *   两段解析，追加字段会把它的 cookie 段搞坏。所以单独一个变量，
   *   由启动器拼成完整格式再用。
   *
   * 值格式：pin#user_agent#uuid#eid_token#wg_token#d_brand#d_model#os_version#build#client_version
   */
  const _h = function (n) { return getHeader(reqHeaders, n) || ''; };
  /* ★ 2026-11-10：设备指纹多数**不在请求头里，而在 URL 查询串里**。
     实测 sh.jd.com/d?fl=...&x-api-eid-token=jdd01...&uuid=...&d_brand=apple…
     只读 headers 会永远采不到（这就是 JD_DEVICE 一直空的原因）。
     这里同时解析 query，头优先、query 兜底。 */
  const _q = (function (url) {
    const out = {};
    const s = String(url || '');
    const i = s.indexOf('?');
    if (i < 0) return out;
    s.slice(i + 1).split('&').forEach(function (kv) {
      if (!kv) return;
      const j = kv.indexOf('=');
      const k = (j < 0 ? kv : kv.slice(0, j)).toLowerCase();
      let v = j < 0 ? '' : kv.slice(j + 1);
      try { v = decodeURIComponent(v); } catch (e) {}
      if (k && out[k] === undefined) out[k] = v;
    });
    return out;
  })(ctx.url);
  const _d = function () {
    for (let i = 0; i < arguments.length; i++) {
      const k = arguments[i];
      const hv = _h(k);
      if (hv) return hv;
      const qv = _q[k.toLowerCase()];
      if (qv) return qv;
    }
    return '';
  };
  /* 抓包优先；抓不到就用配置里写死的兜底（CFG.jdDev） */
  const _C = CFG.jdDev || {};
  const _pick = function (live, fallback) { return live || fallback || ''; };
  const dev = [
    _d('user-agent'),
    _pick(_d('uuid'), _C.uuid),
    _pick(_d('x-api-eid-token'), _C.eid),
    _pick(_d('wg-sdk-token'), _C.wg),
    _pick(_d('d_brand', 'd-brand', 'brand'), _C.brand),
    _pick(_d('d_model', 'd-model', 'model'), _C.model),
    _pick(_d('osversion', 'os-version', 'osVersion'), _C.os),
    _pick(_d('build'), _C.build),
    _pick(_d('clientversion', 'client-version', 'clientVersion'), _C.client),
  ];
  /* 2026-11-10 修：原来要求 client_version 必须有，但京东的 clientVersion
     多数请求**没有独立头**（README 也说「可以从 jdapp UA 取」）→ 门槛过不了 →
     JD_DEVICE 永远不写。现在改成：uuid+eid+wg 三个是硬门槛，
     build / clientVersion 缺了就从 UA 里解析补上。 */
  /* uuid 在部分抓包里是 base64 密文（如 hjudwgohxzVu96krv/T6Hg==），
     JDOOK 只收明文 hex。16 字节 base64 解出来正好 32 位 hex。 */
  (function () {
    const u = dev[1] || '';
    if (/^[0-9a-f]{32}$/i.test(u)) return;                 /* 已经是明文 */
    if (!/^[A-Za-z0-9+/=]{20,28}$/.test(u)) return;        /* 不像 base64 */
    try {
      const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
      let bits = '', out = '';
      for (let i = 0; i < u.length; i++) {
        const ch = u[i];
        if (ch === '=') break;
        const idx = A.indexOf(ch);
        if (idx < 0) return;
        bits += ('000000' + idx.toString(2)).slice(-6);
      }
      for (let i = 0; i + 8 <= bits.length; i += 8) {
        out += ('0' + parseInt(bits.slice(i, i + 8), 2).toString(16)).slice(-2);
      }
      if (out.length === 32) dev[1] = out;
    } catch (e) {}
  })();

  /* UA 兜底：抓包里常是 JD4iPhone 老格式，配置里不传 UA，
     这里用 client/build/os/brand/model/uuid 拼成脚本认的 jdapp; 格式。 */
  if (!dev[0] || !/^jdapp;/i.test(dev[0])) {
    if (dev[8] && dev[1]) {
      const _osu = String(dev[6] || '18.0').replace(/\./g, '_');
      dev[0] = ('jdapp;iPhone;%s;;;M/5.0;appBuild/%s;jdSupportDarkMode/0;'
        + 'Mozilla/5.0 (iPhone; CPU iPhone OS %s like Mac OS X) AppleWebKit/605.1.15 '
        + '(KHTML, like Gecko) Mobile/15E148;supportJDSHWK/1;uuid=%s;osVersion=%s;'
        + 'd_brand=%s;d_model=%s')
        .replace('%s', dev[8]).replace('%s', dev[7] || '171195')
        .replace('%s', _osu).replace('%s', dev[1])
        .replace('%s', dev[6] || '18.0').replace('%s', dev[4] || 'apple')
        .replace('%s', dev[5] || 'iPhone');
    }
  }

  const _ua = dev[0] || '';
  const _mb = /appBuild\/(\d+)/.exec(_ua);
  if (!dev[7] && _mb) dev[7] = _mb[1];                         /* build */
  if (!dev[8]) {
    const _mv = /jdapp;[^;]*;\s*([0-9][0-9.]*)/.exec(_ua) || /appVersion\/([0-9.]+)/.exec(_ua);
    if (_mv) dev[8] = _mv[1];
  }
  /* ★ 2026-11-10 实测：京东的 x-api-eid-token 与 wg-sdk-token 都是 jdd01 开头、
     长度 116，抓包里往往只有前者。JDOOK 那套硬要 wg，实测拿 eid 顶上去它能接受
     （任务真的跑起来了）。所以 wg 缺失时用 eid 兜底。 */
  if (!dev[3] && dev[2]) dev[3] = dev[2];

  const devOk = dev[1] && dev[2] && dev[3];   /* uuid + eid + wg 才是风控三件套 */
  if (devOk) {
    const row = [pin].concat(dev.map(function (x) { return String(x || '').replace(/[#\n\r]/g, ' '); })).join('#');
    jobs.push({
      env: 'JD_DEVICE', pin: pin, cron: 0, note: '设备指纹',
      build: function (old) {
        const cur = splitLines(old).find(function (r) { return r.pin === pin; });
        if (cur && String(cur.cookie || '') === row) return null;   /* 没变就不写，省一次面板请求 */
        return upsertRow(old, pin, row);
      },
    });
  }
  return jobs;
}

/* ── 淘宝 / 饿了么 / 闪购 ──────────────────────────────── */
function handleTaobao(ctx) {
    dbg('taobao | ' + (ctx.url || '').slice(0, 88) + ' ｜ cookie ' + Object.keys(ctx.cookie || {}).length + ' 键' + (getHeader(reqHeaders, 'x-umt') ? ' ｜ x-umt ' + getHeader(reqHeaders, 'x-umt').length + ' 字符' : ''));
  const jobs = [];

  /* ① x-umt 设备头 —— 幸运星领奖必须要它，这是唯一能拿到真值的地方 */
  const umt = getHeader(reqHeaders, 'x-umt') || getHeader(reqHeaders, 'x-umidtoken');
  /* ★ 2026-11-11 诊断 v2：把每一次命中规则的淘宝/闪购请求都记下来（最近 4 条）。
   * 格式 `时:分:秒 umt=32/no-umt <url>`。
   * 三种结论：LOON_DBG 不动 = 规则没命中；全是 no-umt = 命中了但该请求天生不带这个头；
   * 出现 umt=NN = 采到了。5 秒节流，避免一次点击几十个请求刷爆面板。 */
  {
    const _now = Date.now();
    const _last = parseInt(prefGet('tb_dbg_at', '0') || '0', 10) || 0;
    if (_now - _last > 5000) {
      prefSet('tb_dbg_at', String(_now));
      let _seen = [];
      try { _seen = JSON.parse(prefGet('tb_seen', '[]') || '[]'); } catch (e) { _seen = []; }
      if (!Array.isArray(_seen)) _seen = [];
      const _u = String(ctx.url || '');
      const _line = new Date().toISOString().slice(11, 19) + ' '
        + (umt ? ('umt=' + umt.length) : 'no-umt') + ' ' + _u.slice(0, 84);
      _seen.push(_line);
      if (_seen.length > 4) _seen = _seen.slice(-4);
      prefSet('tb_seen', JSON.stringify(_seen));
      jobs.push({
        env: 'LOON_DBG', pin: '_', cron: 0, note: '诊断',
        build: function () { return _seen.join('\n'); },
      });
    }
  }
  /* ★ 2026-11-11：门槛从 40 降到 16。
   * 证据：GitHub Moli-X/Resources Script/Ali.js 里阿里系真机请求的 x-umt 是
   * `58YB2PZLPC8C8RKHR1u9Yzg4XNwg8r0D` —— 32 字符。原来的 >=40 会把真值直接丢掉，
   * 表现就是「其他变量都在更新、只有 MD_UMT 永远停在占位符」。
   * 只要不是中文、长度够 16，就当 umt 收下（服务端还有一层占位符过滤）。 */
  if (umt && umt.length >= 16 && !/[^\x20-\x7e]/.test(umt)) {
    jobs.push({
      env: 'MD_UMT', pin: '_', cron: 0, note: 'x-umt',
      build: function (old) { return umt === String(old || '').trim() ? null : umt; },
    });
  }

  /* ② TB_LUCKYSTAR_ACCOUNTS —— ⚠️ 默认【不写】！
   *
   * 11-06 实测踩到的坑：闪购要的是 ele.me 会话票，其中 `_m_h5_tk` 是 mtop 签名 token，
   * 每次请求后由 **Set-Cookie** 下发新值。Loon 的 http-request 类型**拿不到响应头**，
   * 只能抓到请求里带的旧 token —— 写进面板会把 ActivityHub 扫码产的新票覆盖成旧的，
   * 表现就是 176 任务秒失败（0.1s / NET_ERROR / 登录态失效），而票「看起来」33 个键全在。
   *
   * 所以淘宝票交给 ActivityHub（完整浏览器，能拿最新 _m_h5_tk），Loon 只抓 x-umt。
   * 真要开：argument 里加 tbcookie=1
   */
  if (String(ARG.tbcookie || ARG.TBCOOKIE || '') === '1') {
    const ck = ctx.cookie;
    const keys = Object.keys(ck);
    if (keys.length >= 3) {
      const id = ck['unb'] || ck['munb'] || ck['USERID'] || ck['userId'] || ck['_tb_token_'] || '';
      if (id) {
        const cookieStr = serializeCookie(ck);
        jobs.push({
          env: 'TB_LUCKYSTAR_ACCOUNTS', pin: id, cron: 0, note: 'cookie',
          build: function (old) {
            const rows = splitLines(old);
            let hit = null;
            for (let i = 0; i < rows.length; i++) if (rows[i].pin === id) { hit = rows[i]; break; }
            const merged = hit ? mergeCookiePreferNew(hit.cookie, ck) : cookieStr;
            return upsertRow(old, id, merged);
          },
        });
      }
    }
  } else {
    dbg('taobao | 跳过 cookie（tbcookie≠1）—— 淘宝票交给 ActivityHub，Loon 只管 x-umt');
  }
  return jobs;
}

/* ── 闲鱼 ─────────────────────────────────────────────── */
function handleXianyu(ctx) {
    dbg('xianyu | ' + (ctx.url || '').slice(0, 88) + ' ｜ cookie ' + Object.keys(ctx.cookie || {}).length + ' 键' + (getHeader(reqHeaders, 'x-umt') ? ' ｜ x-umt ' + getHeader(reqHeaders, 'x-umt').length + ' 字符' : ''));
  const ck = ctx.cookie;
  const unb = ck['unb'] || ck['munb'] || '';
  if (!unb) return [];
  if (Object.keys(ck).length < 3) return [];
  return [{
    env: 'XIANYU_COOKIE', pin: unb, cron: 0, note: 'cookie',
    /* 两个需求同时满足：
       ① 有些请求只带 3~5 个 cookie，整串覆盖会把 sgcookie 等签名键冲掉 → 必须合并
       ② cookie2 / _m_h5_tk 是会轮换的凭证 → 必须**新值优先**
       所以用 mergeCookiePreferNew，不是 mergeCookie。 */
    build: function (old) {
      const rows = splitLines(old);
      let hit = null;
      for (let i = 0; i < rows.length; i++) if (rows[i].pin === unb) { hit = rows[i]; break; }
      const merged = hit ? mergeCookiePreferNew(hit.cookie, ck) : serializeCookie(ck);
      return upsertRow(old, unb, merged);
    },
  }];
}

/* ── 联通 ─────────────────────────────────────────────── */
function handleUnicom(ctx) {
  /* token 在请求头，appId 在 query，手机号藏在 UA 的 desmobile 里 */
  const token = getHeader(reqHeaders, 'token') || getHeader(reqHeaders, 'token_online');
    if (!token || String(token).length < 16) {
      dbg('unicom | 缺 token 头（拿到 ' + String(token || '').length + ' 字符）| ' + (ctx.url || '').slice(0, 90));
      return [];
    }

  const appId = paramOf(ctx.url, ctx.body, 'appId') || paramOf(ctx.url, ctx.body, 'appid')
             || paramOf(ctx.url, ctx.body, 'app_id') || '';
    if (!appId || appId.length < 20) {
      dbg('unicom | 缺 appId（拿到 ' + String(appId || '').length + ' 字符）| ' + (ctx.url || '').slice(0, 90));
      return [];
    }

  let phone = '';
  const ua = getHeader(reqHeaders, 'user-agent') || '';
  const m = ua.match(/desmobile[:\s]*(\d{11})/i);
  if (m) phone = m[1];
  if (!phone) {
    /* 有些接口把明文手机号放 query（少见，兜底） */
    const q = queryOf(ctx.url, 'desmobile');
    if (/^1\d{10}$/.test(q)) phone = q;
  }
    if (!phone) {
      dbg('unicom | 缺 desmobile 手机号 | UA=' + ua.slice(0, 60));
      return [];
    }

  const line = token + '#' + appId + '#' + phone;
  return [{
    env: 'chinaUnicomCookie', pin: phone, cron: 0, note: 'token',
    build: function (old) {
      /* ⚠️ chinaUnicomCookie 的格式是 `token#appid#手机号`，
         不是通用的 `pin#payload` —— 匹配键在**最后一段**，不能走 upsertRow。 */
      /* 只留真行：`token#appid#手机号` 三段**都要非空**。
         光数 # 不够 —— 形如 `##1XXXXXXXXXX` 的坏值也是 3 段，
         但 token/appid 全空，留着就是垃圾行。 */
      const rows = String(old || '').split('\n').map(function (x) { return x.trim(); })
        .filter(function (x) {
          if (!x) return false;
          const seg = x.split('#');
          return seg.length >= 3 && seg[0] && seg[1] && seg[seg.length - 1];
        });
      let hit = -1;
      for (let i = 0; i < rows.length; i++) {
        const segs = rows[i].split('#');
        if (segs[segs.length - 1].trim() === phone) { hit = i; break; }
      }
      if (hit >= 0) {
        if (rows[hit].trim() === line) return null;   // 没变
        rows[hit] = line;
      } else {
        rows.push(line);
      }
      return rows.join('\n');
    },
  }];
}

/* ── 值得买 ───────────────────────────────────────────── */
function handleSmzdm(ctx) {
    dbg('smzdm | ' + (ctx.url || '').slice(0, 88) + ' ｜ cookie ' + Object.keys(ctx.cookie || {}).length + ' 键' + (getHeader(reqHeaders, 'x-umt') ? ' ｜ x-umt ' + getHeader(reqHeaders, 'x-umt').length + ' 字符' : ''));
  const ck = ctx.cookie;
  /* 值得买的关键键：sess / user / smzdm_id */
  if (!ck['sess'] && !ck['user']) return [];
  if (Object.keys(ck).length < 3) return [];
  return [{
    env: 'SMZDM_COOKIE', pin: '_single', cron: 0, note: 'cookie',
    /* SMZDM_COOKIE 是纯 cookie 串（没有 pin# 前缀），所以 base 直接就是旧值。
       不合并的话，只带 3 个键的请求会把整串冲成 3 个键。 */
    build: function (old) {
      const base = String(old || '').trim();
      /* 占位值（不是 cookie 形态）不能当 base，否则会混进垃圾键 */
      const usable = base && base.indexOf('=') > 0 && base.indexOf('#') < 0;
      /* 新值优先 —— sess/user 就是凭证，必须覆盖，不能按「指纹键保留」处理 */
      const out = mergeCookiePreferNew(usable ? base : '', ck);
      return out === base ? null : out;
    },
  }];
}

/* ============================================================
 * 主流程
 * ============================================================ */

let doneCalled = false;
function finish() {
  if (doneCalled) return;
  doneCalled = true;
  try { $done({}); } catch (e) { /* ignore */ }
}

function pickPlatform(host) {
  for (let i = 0; i < PLATFORMS.length; i++) {
    const p = PLATFORMS[i];
    for (let j = 0; j < p.hosts.length; j++) {
      if (host === p.hosts[j] || host.endsWith('.' + p.hosts[j])) return p;
    }
  }
  return null;
}

function main() {
  const host = hostOf(reqUrl);
  const plat = pickPlatform(host);
  if (!plat) {
    log('skip | 未登记的 host: ' + host);
    finish();
    return;
  }

  const ctx = { host: host, url: reqUrl, body: reqBody, cookie: collectCookie() };

  let jobs = [];
  try {
    jobs = plat.handle(ctx) || [];
  } catch (e) {
    log(plat.id + ' | handler 异常: ' + (e && e.message ? e.message : e));
    finish();
    return;
  }

  if (!jobs.length) {
    log(plat.id + ' | 这条请求没抓到需要的字段（' + host + '）');
    finish();
    return;
  }

  /* 冷却：同一平台同一身份 30 分钟内不重复写 */
  const ckKey = 'cool_' + plat.id;
  const coolKey = prefGet(ckKey, '');
  const coolTs = Number(prefGet(ckKey + '_ts', 0));
  /* sig 不能只写 env+pin —— 那样「同一个号换了新票」也会被 30 分钟冷却挡住，
     扫码刚拿到的新 pt_key 反而写不进去。把**本次请求的输入**一起算进指纹：
     cookie + x-umt + token 头 + body。输入一变 sig 就变，冷却自然放行；
     同一份输入重复触发才被拦（这才是冷却该做的事）。 */
  const fp = shortHash(
    serializeCookie(ctx.cookie) + '|' +
    getHeader(reqHeaders, 'x-umt') + '|' +
    getHeader(reqHeaders, 'token') + '|' +
    ctx.body
  );
  const sig = plat.id + '|' + fp + '|' + jobs.map(function (j) {
    return j.env + ':' + j.pin;
  }).join(',');
  if (coolKey === sig && NOW - coolTs < CFG.pushCooldown) {
    log(plat.id + ' | skip-cool | 剩 ' + Math.ceil((CFG.pushCooldown - (NOW - coolTs)) / 60000) + ' 分钟');
    finish();
    return;
  }

  /* Loon 会并发跑同一个脚本实例（一个页面加载打 5~10 个请求）。
     如果全放过去，多个 putEnv 都是「读旧值 → 合并 → 写」，并发时会互相覆盖。
     加一道 3 秒闸门：同一平台 3 秒内只放一个请求进去写。
     （冷却 30 分钟管「相同输入」，这道闸门管「并发」，两件事。） */
  const gateKey = 'gate_' + plat.id;
  const gateTs = Number(prefGet(gateKey, 0));
  if (NOW - gateTs < 3000) {
    log(plat.id + ' | skip-gate | 3 秒内已有写入，跳过（防并发覆盖）');
    finish();
    return;
  }
  prefSet(gateKey, String(NOW));

  let tok = '';
  const applied = [];   // [{env, value, cron}]
  const skipped = [];

  getToken()
    .then(function (t) { tok = t; return getEnvs(tok); })
    .then(function (envs) {
      const chain = [];
      jobs.forEach(function (job) {
        chain.push(function () {
          const rec = findEnv(envs, job.env);
          if (!rec) {
            log(plat.id + ' | 跳过 ' + job.env + '：青龙里没这个变量');
            skipped.push(job.env + '(不存在)');
            return null;
          }
          const nv = job.build(String(rec.value || ''));
          if (nv === null || nv === undefined || nv === String(rec.value || '')) {
            skipped.push(job.env);
            return null;
          }
          return putEnv(tok, rec, nv).then(function () {
            /* 关键：把内存里的 rec.value 也更新掉。
               否则同一轮里若有两个 job 写同一个 env，第二个还会拿旧值当 base，
               把第一个刚写的冲掉。 */
            rec.value = nv;
            applied.push({ env: job.env, value: nv, cron: job.cron, note: job.note });
          });
        });
      });
      return chain.reduce(function (p, fn) { return p.then(fn); }, Promise.resolve());
    })
    .then(function () {
      if (!applied.length) {
        log(plat.id + ' | skip-same | 没变化：' + skipped.join(' / '));
        return Promise.reject({ __skip: true });
      }
      /* 回读校验 */
      return getEnvs(tok).then(function (envs2) {
        applied.forEach(function (a) {
          const chk = findEnv(envs2, a.env);
          if (!chk || String(chk.value || '') !== a.value) {
            throw new Error('回读校验失败：' + a.env);
          }
        });
        prefSet(ckKey, sig);
        prefSet(ckKey + '_ts', NOW);
        return true;
      });
    })
    .then(function () {
      /* 只触发第一个非 0 的任务，避免重复跑 */
      const cronId = (applied.map(function (a) { return a.cron; }).filter(function (x) { return x > 0; })[0]) || 0;
      return runCron(tok, cronId).then(function (ok) { return { id: cronId, ok: ok }; });
    })
    .then(function (cronRes) {
      const parts = applied.map(function (a) { return a.env + '(' + a.note + ')'; });
      const cronText = cronRes.id
        ? ('任务 ' + cronRes.id + (cronRes.ok ? ' 已触发' : ' 触发失败'))
        : '无需触发任务';
      log(plat.id + ' | done | ' + parts.join(' ｜ ') + ' | ' + cronText);
      notify('已采集 · ' + plat.name + ' ✅', parts.join('、') + '，' + cronText,
        'host=' + host + '\n' + (skipped.length ? '未变：' + skipped.join(' / ') : ''));
      finish();
    }, function (e) {
      if (e && e.__skip) {
        log(plat.id + ' | skip-same | 没变化：' + skipped.join(' / '));
        finish();
        return;
      }
      const msg = (e && e.message) ? e.message : String(e);
      log(plat.id + ' | fail | ' + msg.slice(0, 90));
      notify('采集失败 · ' + plat.name + ' ⚠️', msg.slice(0, 60), 'host=' + host);
      finish();
    });
}

try {
  checkCfgVersion();   /* 配置版本对不上就提醒一次，不阻断采集 */
  main();
} catch (e) {
  log('crash | ' + (e && e.message ? e.message : e));
  finish();
}
