/**
 * loon-harvest.js —— Loon 凭证采集器（手机 App → 青龙）
 * ============================================================
 * v1.6 ｜ 2026-11-26 ｜ 凭据走 Loon argument，文件本身可公开
 *      1.6：回读校验只校验真凭证，JD_CKDBG/JD_HEADERS/LOON_DBG 诊断探针不再误判整轮失败
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
 *   京东定位  JD_LOCATION              area/lng/lat/tttparams（守护豆田）
 *   快递小哥  KDXG_UNIONID             微信 unionId（lanlv-key）
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
/* Loon TF：脚本 HTTP 默认走 DIRECT，到不了 tailnet IP。
   配置参数传 node=Tailscale-Home 时，青龙 API 请求显式走该节点（与旧 jd_qinglong_loon.js 一致）。 */
/* Loon TF 节点候选：配置用分号分隔多个名字，逐个试到可用为止；空串=不带 node(全局/规则)。
   例：node=Tailscale-Home;Tailscale;global;   最后留空表示兜底不带 node。 */
const NODE_LIST = String(ARG.node || ARG.NODE || '').split(';').map(function(x){return String(x||'').trim();});
if (!NODE_LIST.length) NODE_LIST.push('');
let NODE_LOCK = null;  // 命中后锁定，后续请求直接用

/* 家庭 Wi-Fi 白名单：只有这些 SSID 才执行采集；未配置时保持原行为。
 * 配置方式：在 Loon 的 script(...) 参数里加 &home_ssid=家里WiFi名
 * 多个 SSID 用英文逗号分隔；YOUR_HOME_SSID 是占位符，视为未配置。 */
const HOME_SSIDS = String(ARG.home_ssid || ARG.homeSsid || '')
  .split(',').map(function (s) { return s.trim(); })
  .filter(function (s) { return s && s !== 'YOUR_HOME_SSID'; });

function currentSsid() {
  try {
    if (typeof $config === 'undefined' || !$config || !$config.getConfig) return '';
    var c = JSON.parse($config.getConfig() || '{}');
    return String(c.ssid || '');
  } catch (e) { return ''; }
}

const CFG = {
  version: 'harvest-1.8',

  /* 青龙面板 —— 手机要和服务器同一局域网（京东 Mesh 后面也能通，走 NAT） */
  panel: ARG.panel || ARG.PANEL || '',
  panel2: ARG.panel2 || ARG.PANEL2 || '',   /* 必填 —— 不把服务器地址写死在公开代码里 */
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
const CFG_VER = 6;
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
    hosts: ['sh.jd.com', 'item.m.jd.com', 'api.m.jd.com', 'plogin.m.jd.com',
            'wq.jd.com', 'home.m.jd.com', 'im-x.jd.com', 'msg.m.jd.com',
            'blackhole.m.jd.com', 'perf.m.jd.com'],
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
  {
    /* 2026-11-22：快递小哥（微信小程序）—— 身份是微信 unionId，不在 cookie 里 */
    id: 'kdxg',
    name: '快递小哥',
    hosts: ['jingxiaoge-api-out.jdl.com', 'qiwei-front.jdl.com'],
    handle: handleKdxg,
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
                   'key', 'pin', 'pinId', 'thor', 'token', 'thorToken',
                   'User-Agent', 'user-agent'];

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

/* UA 值内部自带分号（jdapp;iPhone;16.1.90;;;M/5.0;appBuild/171240），
   按 ';' 硬切会被截成 "jdapp" —— 11-25 实测：合并老行时把 UA 切碎，
   JDOOK 认不出系统版本 → 账号被跳过。下面这些键出现在 UA 之后 ⇒ 才是 UA 的终点。 */
const UA_TAIL_STOP = ['pt_key', 'pt_pin', 'light_key', 'wskey', 'pwdt_id', 'sfstoken',
  'uuid', 'x-api-eid-token', 'wg-sdk-token', 'build', 'clientversion',
  '3ab9d23f7a4b3c9b', 'unpl', 'mba_muid', 'shshshfpa', 'shshshfpb', 'unionwsws',
  '__jda', '__jdv', 'qid_fs', 'qid_evord', 'qid_sc', 'qid_uid', 'shshshfpx',
  'iploc-djd', 'area'];

/* "k=v; k2=v2" → {k:v, k2:v2}；User-Agent 单独按「整段」读，不被分号切开 */
function parseCookie(s) {
  const out = {};
  const toks = String(s || '').split(';');
  for (let i = 0; i < toks.length; i++) {
    const kv = toks[i];
    const eq = kv.indexOf('=');
    if (eq <= 0) continue;
    const k = kv.slice(0, eq).trim();
    let v = kv.slice(eq + 1).trim();
    if (k.toLowerCase() === 'user-agent' && /^jdapp(;|$)/i.test(v)) {
      let j = i + 1;
      while (j < toks.length) {
        const t2 = toks[j];
        const e2 = t2.indexOf('=');
        const k2 = e2 > 0 ? t2.slice(0, e2).trim().toLowerCase() : '';
        if (k2 && UA_TAIL_STOP.indexOf(k2) >= 0) break;   /* 到达下一个真键 */
        v += ';' + t2;
        j++;
      }
      i = j - 1;
    }
    if (k) out[k] = v;
  }
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

/* UA 永远写到最后 —— 下次 parseCookie 就能「读到行尾」，不会再被后面的键切开 */
function serializeCookie(obj) {
  const ua = [];
  const rest = [];
  Object.keys(obj).forEach(function (k) {
    if (k.toLowerCase() === 'user-agent' && /^jdapp(;|$)/i.test(String(obj[k]))) ua.push(k);
    else rest.push(k);
  });
  return rest.map(function (k) { return k + '=' + obj[k]; })
    .concat(ua.map(function (k) { return k + '=' + obj[k]; })).join(';');
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
      if (!NODE_LIST.join('') && typeof $task !== 'undefined' && $task && $task.fetch) {
        $task.fetch({ url: opts.url, method: method, headers: opts.headers || {}, body: opts.body || undefined })
          .then(function (r) { ok({ status: r.statusCode || r.status || 0, body: r.body || '' }); },
                function (e) { no(new Error('网络失败: ' + (e && e.error ? e.error : e))); });
        return;
      }
      if (typeof $httpClient !== 'undefined' && $httpClient) {
        /* PUT fallback：Loon 无 $httpClient.put 时用 post（绝不降成 get）。 */
        const fn = (method === 'PUT')
          ? (typeof $httpClient.put === 'function' ? $httpClient.put : $httpClient.post)
          : (typeof $httpClient[method.toLowerCase()] === 'function' ? $httpClient[method.toLowerCase()] : $httpClient.get);
        const base = { url: opts.url, headers: opts.headers || {}, body: opts.body || undefined };
        /* 节点候选链（2026-11-25）：逐个试 NODE_LIST，任一成功即锁定该节点。
           policy 错误在某些 Loon 版本只弹窗不进 err 回调 ⇒ 只能靠"实际请求是否成功"判定。 */
        const candidates = opts.noNode ? [''] : ((NODE_LOCK !== null) ? [NODE_LOCK] : NODE_LIST.slice());
        const tryIdx = function (i) {
          if (i >= candidates.length) return no(new Error('网络失败: 所有节点候选都失败 (' + candidates.join('|') + ')'));
          const o = Object.assign({}, base);
          const nd = candidates[i];
          if (nd) o.node = nd;
          fn(o, function (err, resp, body) {
            if (err) return tryIdx(i + 1);  // 试下一个候选
            NODE_LOCK = nd;                 // 锁定可用节点
            ok({ status: (resp && (resp.status || resp.statusCode)) || 0, body: body || '' });
          });
        };
        tryIdx(0);
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

/* 面板域名兜底：主面板（tailnet，需 node）失败 → 试 panel2（家里内网，走 DIRECT 不带 node） */
function qlTry(opts) {
  return http(opts).catch(function (e) {
    if (!CFG.panel2 || String(opts.url).indexOf(CFG.panel2) === 0) throw e;
    const o2 = Object.assign({}, opts);
    o2.url = String(opts.url).replace(CFG.panel, CFG.panel2);
    o2.noNode = true;
    return http(o2).then(function (r) {
      log('panel-fallback | 主面板不通，本次改用 panel2');
      CFG.panel = CFG.panel2;   /* 命中后本轮固定用备用，少绕一圈 */
      return r;
    });
  });
}

function getToken() {
  const cached = prefGet('ql_tok', '');
  const exp = Number(prefGet('ql_tok_exp', 0));
  if (cached && exp > NOW) return Promise.resolve(cached);

  if (!CFG.panel) {
    return Promise.reject(new Error('没配 panel —— 去 Loon 配置 [Script] 规则的 argument= 里填 panel=http://你的服务器:5711'));
  }
  const u = CFG.panel + '/open/auth/token?client_id=' +
    encodeURIComponent(CFG.clientId) + '&client_secret=' + encodeURIComponent(CFG.clientSecret);

  return qlTry({ url: u, method: 'GET' }).then(function (r) {
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
  return qlTry({
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
  return qlTry({
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
  return qlTry({
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


/* 2026-11-26：特价版只给 wskey + pin_hash，没有 pt_pin。
   用 JD_COOKIE 已有账号做配对：同值 cookie（unionwsws 等）优先，其次 pin_hash（Java hash）。
   配不上就退回纯 jskey 行，交给 180 自己解析 pin。 */
function jdJavaHash(text) {
  const s = String(text);
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return String(h);
}
function jdSafeDecode(v) {
  const s = String(v || '');
  if (s.indexOf('%') < 0) return s;
  try { return decodeURIComponent(s); } catch (e) { return s; }
}
function jdPinFromEnvs(envs, ck) {
  const list = envs || [];
  let rec = null;
  for (let i = 0; i < list.length; i += 1) {
    if (list[i].name === 'JD_COOKIE') { rec = list[i]; break; }
  }
  if (!rec) return '';
  const rows = splitLines(rec.value);
  if (!rows.length) return '';
  const keys = ['unionwsws', 'pwdt_id', 'mba_muid', 'uuid'];
  for (let k = 0; k < keys.length; k += 1) {
    const name = keys[k];
    const want = ck[name];
    if (!want) continue;
    const hits = [];
    for (let i = 0; i < rows.length; i += 1) {
      const m = new RegExp('(?:^|;)\\s*' + name + '=([^;]+)').exec(rows[i].cookie || '');
      if (m && m[1].trim() === String(want).trim()) hits.push(rows[i].pin);
    }
    if (hits.length === 1) return hits[0];
  }
  const hash = ck['pin_hash'];
  if (hash) {
    const hits = [];
    for (let i = 0; i < rows.length; i += 1) {
      if (jdJavaHash(jdSafeDecode(rows[i].pin)) === String(hash)) hits.push(rows[i].pin);
    }
    if (hits.length === 1) return hits[0];
  }
  if (rows.length === 1) return rows[0].pin;
  return '';
}

/* JD_WSKEY 专用：允许「纯 wskey」行（无 pin）。
   特价版 App 只给 wskey，不给 pt_pin；180 的 parse_wskey_blob 支持纯行，
   换 CK 时从 genToken 结果里拿 pt_pin。
   ⚠️ 不能走 splitLines/upsertRow —— 它们会把不含 # 的纯行直接丢掉。 */
function upsertWskeyLine(value, pin, payload) {
  const lines = String(value || '').split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === payload) return null;
    if (lines[i].slice(-(payload.length + 1)) === '#' + payload) return null;
  }
  if (pin) {
    for (let i = 0; i < lines.length; i++) {
      const k = lines[i].indexOf('#');
      if (k > 0 && lines[i].slice(0, k).trim() === pin) {
        lines[i] = pin + '#' + payload;
        return lines.join('\n');
      }
    }
    lines.push(pin + '#' + payload);
    return lines.join('\n');
  }
  /* 无 pin：若有旧的纯行就替换（同一台手机换号重登，旧票已废），否则追加 */
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].indexOf('#') < 0) { lines[i] = payload; return lines.join('\n'); }
  }
  lines.push(payload);
  return lines.join('\n');
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
        env: 'JD_HEADERS', pin: '_', cron: 0, note: '头名诊断', quiet: true,
        build: function (old) {
          const cur = String(old || '').trim();
          if (cur === v) return null;
          return v;
        },
      }];
    } catch (e) { return []; }
  })();

  /* ★ 2026-11-25 wskey 探针（自动适配版）
     京东把 wskey 藏在哪个子域一直在变（社区脚本用的是 blackhole.m.jd.com/getinfo）。
     这里对**所有 *.jd.com** 请求记录一条 `时:分:秒 host=… n=… wskey=Y/N keys=…`（只记键名），
     节流规则：重点域名（blackhole/perf/im-x/msg.m/wskey）或**带 wskey** 立即记；
     其它域名同一 host 30 分钟最多一条，最多留 60 个 host —— 不刷爆青龙。 */
  const _ckProbe = (function () {
    try {
      const h = String(ctx.host || '');
      if (!/(^|\.)jd\.com$/i.test(h)) return [];
      const ckx = ctx.cookie || {};
      const hasW = !!ckx['wskey'];
      const keyHost = /(^|\.)(blackhole\.m|perf\.m|im-x|msg\.m|wskey)\.jd\.com$/i.test(h);
      const mapKey = 'ckdbg_hosts';
      let map = {};
      try { map = JSON.parse(prefGet(mapKey, '{}') || '{}') || {}; } catch (e) { map = {}; }
      const lastTs = Number(map[h] || 0);
      if (!hasW && !keyHost && NOW - lastTs < 30 * 60000) return [];
      map[h] = NOW;
      const hs = Object.keys(map);
      if (hs.length > 60) {
        hs.sort(function (a, b) { return map[a] - map[b]; })
          .slice(0, hs.length - 60).forEach(function (x) { delete map[x]; });
      }
      prefSet(mapKey, JSON.stringify(map));
      const keys = Object.keys(ckx).map(function (k) { return String(k).toLowerCase(); }).sort();
      const d = new Date(NOW + 8 * 3600 * 1000);
      const p2 = function (n) { return (n < 10 ? '0' : '') + n; };
      const stamp = p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()) + ':' + p2(d.getUTCSeconds());
      /* 只留最近 6 条，最新在最上面 —— 一眼能看出京东到底在哪些子域上带哪些键 */
      const line = (stamp + ' ' + h + ' n=' + keys.length + ' W=' + (hasW ? 'Y' : 'N')
        + (hasW ? ' keys=' + keys.join(',') : '')).slice(0, 220);
      return [{
        env: 'JD_CKDBG', pin: '_', cron: 0, note: 'wskey探针', quiet: true,
        build: function (old) {
          const rows = String(old || '').split('\n')
            .map(function (x) { return x.trim(); })
            .filter(function (x) { return /^[0-9]{2}:[0-9]{2}:[0-9]{2}\s/.test(x) && x !== line; });
          rows.unshift(line);
          const out = rows.slice(0, 6).join('\n');
          if (out === String(old || '').trim()) return null;
          return out;
        },
      }];
    } catch (e) { return []; }
  })();

  const ck = ctx.cookie;
  /* 2026-11-25：京东新版 Cookie 里账号名可能只叫 `pin`（blackhole/perf 这类域名就是），
     pt_pin 是老的。两个都认，否则抓到 wskey 也会因为「没有 pin」被判无效。 */
  const pin = ck['pt_pin'] || ck['pin'] || '';
  const ptKey = ck['pt_key'] || ck['light_key'] || '';
  const wskey = ck['wskey'] || '';
  const pinOk = validPin(pin);
  if (!pinOk) {
    /* 说清楚是「挡掉了」而不是「没抓到」，不然排查时一头雾水 */
    if (pin) log('jd | pin 被黑名单/格式挡掉：' + pin + '（京东测试账号会污染真实 pin）');
    if (!wskey) return _probe.concat(_ckProbe);
    /* 2026-11-26：京东特价版（以及新版 App）的 api.m.jd.com 只带 wskey + pin_hash，
       没有 pt_pin/pin。原逻辑在这里直接 return，wskey 永远写不进 JD_WSKEY。
       现在改成写「纯 wskey 行」，180 换 CK 时会从 genToken 的 pt_pin 反推账号。 */
    log('jd | 无 pin 只带 wskey（特价版）→ 写纯 wskey 行，交给 180 解析账号');
  }
  if (!ptKey && !wskey) return _probe.concat(_ckProbe);

  const jobs = [].concat(_ckProbe);
  if (ptKey && pinOk) {
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
  } else if (ptKey) {
    log('jd | 有 pt_key 但没有 pin，无法按键合并 JD_COOKIE，跳过这一轮（等带 pin 的请求）');
  }
  if (wskey) {
    const wskeyJob = {
      env: 'JD_WSKEY', pin: pinOk ? pin : '',
      /* 只有 wskey 时走换 CK；有 pt_key 就不必再烧一次 genToken */
      cron: ptKey ? 0 : CFG.cron.jdConvert,
      note: 'wskey',
      build: function (old, envs) {
        let p = pinOk ? pin : '';
        if (!p) {
          p = jdPinFromEnvs(envs, ck);
          if (p) {
            wskeyJob.pin = p;
            log('jd | 无 pin 的 wskey 按 JD_COOKIE 配对到 ' + p);
          }
        }
        return upsertWskeyLine(old, p, wskey);
      },
    };
    jobs.push(wskeyJob);
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
  if (devOk && pinOk) {
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

  /* ④ JD_LOCATION —— 守护豆田的实时定位（2026-11-22 加）
   * 来源：api.m.jd.com 的 POST 表单或 Referer / URL 里的
   *       gps_area / area / un_area、lng / lat，以及 tttparams。
   * tttparams 是带前缀的 base64 JSON，这里只把原样字符串送回青龙，
   * 由 account_common.location_from_referer() 解码（它已处理干扰码）。
   * 格式：pin#area#lng#lat#tttparams（后 4 段可空，至少一段有值才写）。
   */
  (function () {
    const _bodyVal = function (name) {
      const m = new RegExp('(?:^|&)' + name + '=([^&]*)', 'i').exec(ctx.body || '');
      if (!m) return '';
      try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
    };
    const _val = function (names) {
      for (let i = 0; i < names.length; i++) {
        const v = _d(names[i]) || _bodyVal(names[i]);
        if (v) return v;
      }
      return '';
    };
    const _ttt = (function () {
      const srcs = [ctx.body || '', getHeader(reqHeaders, 'referer') || '', ctx.url || ''];
      for (let i = 0; i < srcs.length; i++) {
        const m = /(?:^|[?&#])tttparams=([^&#\s"'\\]+)/i.exec(srcs[i]);
        if (m) { try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; } }
      }
      return '';
    })();
    const area = _val(['gps_area', 'area', 'un_area', 'lbsArea']);
    const lng = _val(['lng', 'longitude']);
    const lat = _val(['lat', 'latitude']);
    if (!pinOk || (!area && !lng && !lat && !_ttt)) return;   /* 无 pin 不写 JD_LOCATION，避免空 pin 行 */
    const clean = function (x) { return String(x || '').replace(/[#\n\r]/g, ' '); };
    const row = [pin, clean(area), clean(lng), clean(lat), clean(_ttt)].join('#');
    jobs.push({
      env: 'JD_LOCATION', pin: pin, cron: 0, note: '守护豆田定位',
      build: function (old) {
        const cur = splitLines(old).find(function (r) { return r.pin === pin; });
        if (cur && String(cur.cookie || '') === row) return null;
        /* 新值只补空段，已有真值不被后来的空值冲掉 */
        const prev = cur ? String(cur.cookie || '').split('#') : ['', '', '', '', ''];
        const merged = [pin, clean(area) || (prev[1] || ''), clean(lng) || (prev[2] || ''),
                        clean(lat) || (prev[3] || ''), clean(_ttt) || (prev[4] || '')].join('#');
        if (cur && String(cur.cookie || '') === merged) return null;
        return upsertRow(old, pin, merged);
      },
    });
  })();
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
        env: 'LOON_DBG', pin: '_', cron: 0, note: '诊断', quiet: true,
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

/* ── 快递小哥 · 微信 unionId（2026-11-22 加） ─────────────────
 * 微信小程序接口头 lanlv-key 就是 unionId（不是请求体里的 shareUnionId）。
 * KDXG_UNIONID 格式：pt_pin=unionId，用 & 或换行分隔 —— 脚本按这个读。
 */
function handleKdxg(ctx) {
  const union = getHeader(reqHeaders, 'lanlv-key')
    || paramOf(ctx.url, ctx.body, 'unionId')
    || getHeader(reqHeaders, 'unionid') || '';
  if (!/^o[A-Za-z0-9_-]{10,40}$/.test(union)) {
    dbg('kdxg | unionId 不合格式（拿到 ' + String(union).slice(0, 10) + '…）');
    return [];
  }
  const pin = ctx.cookie['pt_pin'] || getHeader(reqHeaders, 'pt_pin')
    || getHeader(reqHeaders, 'ptPin') || '';
  if (!validPin(pin)) {
    dbg('kdxg | 没抓到 pt_pin，unionId 无法归属账号');
    return [];
  }
  return [{
    env: 'KDXG_UNIONID', pin: pin, cron: 0, note: 'unionId',
    build: function (old) {
      const rows = String(old || '').split(/[&\r\n,]+/).map(function (x) { return x.trim(); })
        .filter(function (x) { return x.indexOf('=') > 0; });
      const line = pin + '=' + union;
      let hit = -1;
      for (let i = 0; i < rows.length; i++) {
        if (rows[i].split('=')[0].trim() === pin) { hit = i; break; }
      }
      if (hit >= 0) {
        if (rows[hit] === line) return null;
        rows[hit] = line;
      } else {
        rows.push(line);
      }
      return rows.join('\n');
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
  /* ★ 2026-11-25 自动适配：京东域名太多（wskey 到底落在哪个子域一直在变），
     只要是 *.jd.com 就交给京东 handler；探针只记录、不乱写。 */
  if (/(^|\.)jd\.com$/i.test(host)) return PLATFORMS[0];
  return null;
}

function main() {
  const ssid = currentSsid();
  if (HOME_SSIDS.length && HOME_SSIDS.indexOf(ssid) === -1) {
    log('skip-ssid | 当前 SSID=' + (ssid || '(未知)') + '，不在家庭白名单');
    finish();
    return;
  }

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
  /* 带 wskey 的请求 / blackhole、perf 这类关键域名，优先级最高，不被 3 秒闸门吃掉 */
  const _prio = !!(ctx.cookie['wskey'] || /(^|\.)(blackhole\.m|perf\.m)\.jd\.com$/i.test(host));
  if (!_prio && NOW - gateTs < 3000) {
    log(plat.id + ' | skip-gate | 3 秒内已有写入，跳过（防并发覆盖）');
    finish();
    return;
  }
  prefSet(gateKey, String(NOW));

  let tok = '';
  const applied = [];   // [{env, value, cron}]
  const skipped = [];
  const real = [];      // 只算真内容（排除 JD_HEADERS / JD_CKDBG / LOON_DBG 这类诊断探针）

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
          const rec_old = String(rec.value || '');
          const nv = job.build(rec_old, envs);
          if (nv === null || nv === undefined || nv === String(rec.value || '')) {
            skipped.push(job.env);
            return null;
          }
          return putEnv(tok, rec, nv).then(function () {
            /* 关键：把内存里的 rec.value 也更新掉。
               否则同一轮里若有两个 job 写同一个 env，第二个还会拿旧值当 base，
               把第一个刚写的冲掉。 */
            rec.value = nv;
            const isNewRow = job.pin && job.pin !== '_' && String(rec_old || '').indexOf(job.pin) === -1;
            applied.push({ env: job.env, value: nv, cron: job.cron, note: job.note, quiet: !!job.quiet, isNew: isNewRow });
          });
        });
      });
      return chain.reduce(function (p, fn) { return p.then(fn); }, Promise.resolve());
    })
    .then(function () {
      /* 2026-11-25：诊断探针（JD_HEADERS / JD_CKDBG / LOON_DBG）不算「抓包内容」，
         只有真正的凭证变量变了才提示 + 触发下游任务。 */
      applied.forEach(function (a) { if (!a.quiet) real.push(a); });
      if (!real.length) {
        log(plat.id + ' | skip-same | 没变化：' + (skipped.concat(applied.map(function (a) { return a.env + '(诊断)'; }))).join(' / '));
        return Promise.reject({ __skip: true });
      }
      /* 回读校验（2026-11-26：只校验真凭证，诊断探针跳过）
         诊断探针 JD_CKDBG / JD_HEADERS / LOON_DBG 是 Loon 并发请求共写的，
         后一个请求会把前一个刚写的值覆盖掉；回读必然偶发不一致。
         它们不承载凭证，严格校验会把整轮采集误判为 fail、顺带吞掉任务触发，
         所以 quiet 项只写不验（写失败也不影响凭证）。 */
      return getEnvs(tok).then(function (envs2) {
        applied.forEach(function (a) {
          if (a.quiet) return;
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
      const cronId = (real.map(function (a) { return a.cron; }).filter(function (x) { return x > 0; })[0]) || 0;
      return runCron(tok, cronId).then(function (ok) { return { id: cronId, ok: ok }; });
    })
    .then(function (cronRes) {
      const parts = real.map(function (a) { return a.env + '(' + a.note + ')'; });
      const cronText = cronRes.id
        ? ('任务 ' + cronRes.id + (cronRes.ok ? ' 已触发' : ' 触发失败'))
        : '无需触发任务';
      log(plat.id + ' | done | ' + parts.join(' ｜ ') + ' | ' + cronText);
      /* 2026-11-25：京东 App 的 pt_key 每次开屏都会换一把，照「值变了就提示」会变成天天刷屏。
         现在只有「新账号」或「采到 JD_WSKEY」才立刻提示；其余 6 小时最多一条。 */
      const isNewAcct = real.some(function (a) { return a.isNew; });
      const isKeyCap = real.some(function (a) { return a.env === 'JD_WSKEY'; });
      const lastNt = Number(prefGet('nt_' + plat.id, 0));
      const throttled = !isNewAcct && !isKeyCap && (NOW - lastNt < 6 * 3600 * 1000);
      if (throttled) {
        log(plat.id + ' | done-silent | 已在 ' + Math.round((NOW - lastNt) / 60000) + ' 分钟前提示过，这次不弹');
      } else {
        prefSet('nt_' + plat.id, String(NOW));
        notify('已采集 · ' + plat.name + ' ✅', parts.join('、') + '，' + cronText,
          'host=' + host + '\n' + (skipped.length ? '未变：' + skipped.join(' / ') : ''));
      }
      finish();
    }, function (e) {
      if (e && e.__skip) {
        log(plat.id + ' | skip-same | 没变化：' + skipped.join(' / '));
        finish();
        return;
      }
      const msg = (e && e.message) ? e.message : String(e);
      log(plat.id + ' | fail | ' + msg.slice(0, 90));
      /* 同一条错误 30 分钟内只弹一次（之前一次点击会弹两三条一模一样的「采集失败」） */
      const fh = shortHash(msg);
      let seen = {};
      try { seen = JSON.parse(prefGet('failmap_' + plat.id, '{}') || '{}') || {}; } catch (e2) { seen = {}; }
      Object.keys(seen).forEach(function (k) { if (NOW - Number(seen[k] || 0) > 30 * 60000) delete seen[k]; });
      if (seen[fh]) {
        log(plat.id + ' | fail-silent | 同样错误 30 分钟内已提示过');
      } else {
        const ks = Object.keys(seen);
        if (ks.length > 20) delete seen[ks[0]];
        seen[fh] = NOW;
        prefSet('failmap_' + plat.id, JSON.stringify(seen));
        notify('采集失败 · ' + plat.name + ' ⚠️', msg.slice(0, 60), 'host=' + host);
      }
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
