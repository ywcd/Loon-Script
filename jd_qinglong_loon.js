/*
 * 京东 CK → 青龙面板API
 * Shadowrocket / Surge http-request 脚本，需开启 MITM。
 * 抓 account_common.py 的 REQUIRED_FIELDS，守护豆田再加 area/lng/lat。
 * Cookie → pt_key/pt_pin；UA → 完整 jdapp;…
 * URL/body/Cookie → uuid、eid、机型、版本；Referer tttparams → area/lng/lat
 * 跨请求缓存后拼成一条 JD_COOKIE 推到面板，并自动维护 JD_USER_AGENT。
 */

/* Loon：优先从 $argument 读（panel / cid / secret），没填才用下方默认值 */
var ARG = (function () {
  var raw = "";
  try { raw = (typeof $argument !== "undefined" && $argument) ? String($argument) : ""; } catch (e) {}
  var o = {};
  raw.split("&").forEach(function (kv) {
    var i = kv.indexOf("=");
    if (i > 0) {
      try { o[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1)); }
      catch (e) { o[kv.slice(0, i)] = kv.slice(i + 1); }
    }
  });
  return o;
})();

var CFG = {
  panel: ARG.panel || ARG.PANEL || "",   /* 必填 —— 青龙地址只从 argument 传，脚本本体不写内网地址，可公开上传 */
  node: ARG.node || "",                   /* $httpClient 显式指定节点（Loon 脚本 HTTP 默认不走规则） */
  clientId: ARG.cid || ARG.clientId || "填写新的Client ID",
  clientSecret: ARG.secret || ARG.clientSecret || "填写新的Client Secret",
  minGapMin: 1,
  pushBean: true,
  notify: true
};

/* 统一变量：所有京东脚本只读 JD_COOKIE。
   抓包脚本写完整 11 段 + 占位网页指纹键，172 的 enriched() 见到占位键就跳过
   浏览器补指纹/回写，不会把含分号的 App UA 拆碎（172 本身不用改）。 */
var ENV_NAME = "JD_COOKIE";
var UA_ENV_NAME = "JD_USER_AGENT";
var LOC_ENV_NAME = "JD_LOCATION";   /* 守护豆田定位：pin#area#lng#lat */
var NOTIFY_GAP_MS = 10 * 60 * 1000;
var DEV_KEY = "jdck_dev_v3";
var MAX_HOLD_MS = 28000; // 青龙 OpenAPI 多步请求需要更长等待时间
var DOWN_COOL_MIN = 15;  // 推送失败后 15 分钟内不再尝试
var PUSH_HOSTS = { "api.m.jd.com": 1, "sh.jd.com": 1 };

function log(s) { console.log("[jd-ck] " + s); }

function hdr(headers, name) {
  if (!headers) return "";
  var want = String(name).toLowerCase();
  for (var k in headers) {
    if (String(k).toLowerCase() === want) return String(headers[k] == null ? "" : headers[k]);
  }
  return "";
}

function dec(v) {
  if (v == null) return "";
  v = String(v);
  if (v.indexOf("%") < 0) return v;
  try { return decodeURIComponent(v); } catch (e) { return v; }
}

function cval(cookie, key) {
  if (!cookie) return "";
  var want = String(key).toLowerCase();
  var parts = String(cookie).split(";");
  for (var i = 0; i < parts.length; i++) {
    var s = parts[i].replace(/^\s+|\s+$/g, "");
    var eq = s.indexOf("=");
    if (eq > 0 && s.slice(0, eq).replace(/^\s+|\s+$/g, "").toLowerCase() === want) {
      return s.slice(eq + 1).replace(/^\s+|\s+$/g, "").replace(/^["']|["']$/g, "");
    }
  }
  return "";
}

function params(text) {
  var out = {};
  var parts = String(text || "").split("&");
  for (var i = 0; i < parts.length; i++) {
    if (!parts[i]) continue;
    var eq = parts[i].indexOf("=");
    var k = dec(eq < 0 ? parts[i] : parts[i].slice(0, eq)).replace(/^\s+|\s+$/g, "");
    if (k) out[k] = dec(eq < 0 ? "" : parts[i].slice(eq + 1));
  }
  return out;
}

function flat(obj, out, depth) {
  if (!obj || typeof obj !== "object" || depth > 3) return out;
  for (var k in obj) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
    var v = obj[k];
    if (v && typeof v === "object") flat(v, out, depth + 1);
    else if (v != null && (out[k] == null || out[k] === "")) out[k] = String(v);
  }
  return out;
}

function bodyFields(body) {
  var out = {};
  if (body == null || body === "") return out;
  var t = String(body).replace(/^\s+|\s+$/g, "");
  if (t.charAt(0) === "{" || t.charAt(0) === "[") {
    try { flat(JSON.parse(t), out, 0); } catch (e) {}
    return out;
  }
  out = params(t);
  var inner = String(out.body || "").replace(/^\s+|\s+$/g, "");
  if (inner.charAt(0) === "{" || inner.charAt(0) === "[") {
    try { flat(JSON.parse(inner), out, 0); } catch (e) {}
  }
  return out;
}

function lower(o) {
  var m = {};
  for (var k in o) {
    if (Object.prototype.hasOwnProperty.call(o, k)) m[String(k).toLowerCase()] = o[k];
  }
  return m;
}

function hostOf(url) {
  var m = String(url || "").match(/^[a-z]+:\/\/([^\/:?#]+)/i);
  return m ? m[1].toLowerCase() : "";
}

/* tttparams：带二进制前缀的 base64，只取 area / lng / lat（都是 ASCII） */
var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function b64decode(s) {
  var o = "", b = 0, n = 0;
  for (var i = 0; i < s.length; i++) {
    var v = B64.indexOf(s.charAt(i));
    if (v < 0) continue;
    b = (b << 6) | v;
    n += 6;
    if (n >= 8) { n -= 8; o += String.fromCharCode((b >> n) & 255); }
  }
  return o;
}

function tttValues(text) {
  var m = String(text || "").match(/tttparams=([^&#\s]+)/);
  if (!m) return {};
  var raw = dec(m[1]);
  var k = raw.indexOf("eyJ");
  if (k < 0) return {};
  var s = b64decode(raw.slice(k % 4));
  var out = {}, a;
  a = s.match(/(?:^|[,{])"gps_area":"([^"]*)"/) || s.match(/(?:^|[,{])"area":"([^"]*)"/);
  if (a) out.area = a[1];
  a = s.match(/(?:^|[,{])"lng":"([^"]*)"/);
  if (a) out.lng = a[1];
  a = s.match(/(?:^|[,{])"lat":"([^"]*)"/);
  if (a) out.lat = a[1];
  return out;
}

/* 校验规则与 account_common.py 一致 */
function valid(key, v) {
  if (key === "uuid" || key === "openudid") return /^(?:[0-9a-fA-F]{32,40}|\d{8,24}-\d{8,24}|[A-Za-z0-9+\/]{20,28}={0,2})$/.test(v);
  if (key === "eid") return v.indexOf("jdd") === 0 && v.length >= 100 && v.length <= 400;
  if (key === "wg") return v.indexOf("jdd01") === 0 && v.length >= 100;
  if (key === "d_brand") return /^[A-Za-z0-9 ._-]{2,20}$/.test(v);
  if (key === "d_model") return /^[A-Za-z0-9 .,_-]{2,24}$/.test(v);
  if (key === "osVersion") return /^\d+(?:\.\d+){0,2}$/.test(v);
  if (key === "build") return /^\d{5,8}$/.test(v);
  if (key === "clientVersion") return /^\d+(?:\.\d+){1,3}$/.test(v);
  if (key === "area") return /^\d{1,4}(?:_\d{1,7}){2,3}$/.test(v);
  if (key === "lng" || key === "lat") return /^-?\d{1,3}\.\d+$/.test(v);
  if (key === "screen") return /^\d{2,5}[*x]\d{2,5}$/.test(v);
  if (key === "partner") return /^[A-Za-z0-9._-]{1,32}$/.test(v);
  return !!v;
}

var ALIAS = {
  uuid: ["uuid", "openudid"],
  openudid: ["openudid"],
  eid: ["x-api-eid-token", "xapieidtoken"],
  wg: ["wg-sdk-token"],
  d_brand: ["d_brand", "dbrand"],
  d_model: ["d_model", "dmodel"],
  osVersion: ["osVersion", "osversion", "os_version"],
  build: ["build"],
  clientVersion: ["clientVersion", "clientversion", "client_version"],
  area: ["area", "gps_area", "un_area"],
  lng: ["lng", "longitude"],
  lat: ["lat", "latitude"],
  screen: ["screen"],
  partner: ["partner"]
};
var KEYS = ["uuid", "openudid", "eid", "wg", "d_brand", "d_model", "osVersion",
  "build", "clientVersion", "area", "lng", "lat", "screen", "partner"];

function pick(key, raw) {
  var v = dec(raw).replace(/^\s+|\s+$/g, "").replace(/^["']|["']$/g, "");
  if (!v || v.indexOf("cipher") >= 0 || v.charAt(0) === "{") return "";
  return valid(key, v) ? v : "";
}

function normalizeJDUserAgent(value) {
  var ua = String(value || "").replace(/^\s+|\s+$/g, "");
  if (ua.indexOf("jdapp;") !== 0) return "";
  var parts = ua.split(";");
  for (var i = 1; i < parts.length; i++) {
    if (/^appBuild\/\d{5,8}$/.test(parts[i])) {
      return parts.slice(0, i + 1).join(";");
    }
  }
  return "";
}

function collect(req) {
  var headers = (req && req.headers) || {};
  var cookie = hdr(headers, "Cookie");
  var q = lower(params(String((req && req.url) || "").split("?")[1] || ""));
  var b = lower(bodyFields(req && req.body));
  var h = lower(headers);

  var f = { pt_key: cval(cookie, "pt_key"), pt_pin: cval(cookie, "pt_pin") };
  var ua = hdr(headers, "User-Agent").replace(/^\s+|\s+$/g, "");
  if (ua) f["User-Agent"] = ua;

  for (var i = 0; i < KEYS.length; i++) {
    var key = KEYS[i], v = "", names = ALIAS[key];
    for (var j = 0; j < names.length && !v; j++) {
      var n = names[j].toLowerCase();
      v = pick(key, h[n]) || pick(key, q[n]) || pick(key, b[n]) || pick(key, cval(cookie, names[j]));
    }
    if (v) f[key] = v;
  }

  if (!f.area || !f.lng || !f.lat) {
    var t = tttValues(hdr(headers, "Referer"));
    if (!t.lng || !t.lat) t = tttValues(req && req.body) || t;
    if (!f.area && t.area) f.area = pick("area", t.area);
    if (!f.lng && t.lng) f.lng = pick("lng", t.lng);
    if (!f.lat && t.lat) f.lat = pick("lat", t.lat);
  }

  if (!f.build && f["User-Agent"]) {
    var bm = f["User-Agent"].match(/appBuild\/(\d{5,8})/);
    if (bm) f.build = bm[1];
  }
  if (!f.clientVersion && f["User-Agent"]) {
    var cm = f["User-Agent"].match(/jdapp;[^;]*;([^;]+);/);
    if (cm && valid("clientVersion", cm[1])) f.clientVersion = cm[1];
  }
  return f;
}

/* ---------------- 跨请求缓存 ---------------- */

/* 兜底：把你原配置 argument 里的 jduuid/jdeid/… 灌进设备缓存。
   京东 App 不是每个请求都带全 9 字段；有这些兜底值 missing() 才不会一直跳过。 */
function seedDevFromArg() {
  var map = {
    jduuid: "uuid", openudid: "openudid", jdeid: "eid", jdwg: "wg",
    jdbrand: "d_brand", jdmodel: "d_model", jdos: "osVersion",
    jdbuild: "build", jdclient: "clientVersion"
  };
  var dev = loadDev(), changed = false;
  for (var k in map) {
    if (ARG[k] && !dev[map[k]]) { dev[map[k]] = String(ARG[k]); changed = true; }
  }
  if (ARG.jdos && ARG.jdclient && !dev.ua) {
    dev.ua = "jdapp;iPhone;" + ARG.jdclient + ";;;M/5.0;appBuild/" + (ARG.jdbuild || "") + ";";
    changed = true;
  }
  if (changed) saveDev(dev);
}

function loadDev() {
  try { return JSON.parse($persistentStore.read(DEV_KEY) || "{}") || {}; } catch (e) { return {}; }
}
function saveDev(d) { $persistentStore.write(JSON.stringify(d), DEV_KEY); }

function mergeDev(f) {
  var dev = loadDev(), changed = false;
  if (f.uuid && dev.uuid && f.uuid !== dev.uuid) { dev = {}; changed = true; }
  for (var i = 0; i < KEYS.length; i++) {
    var k = KEYS[i];
    if (f[k] && f[k] !== dev[k]) { dev[k] = f[k]; changed = true; }
  }
  var ua = normalizeJDUserAgent(f["User-Agent"] || "");
  if (ua && ua !== dev.ua) {
    dev.ua = ua;
    changed = true;
  }
  if (changed) saveDev(dev);
  for (var j = 0; j < KEYS.length; j++) {
    if (!f[KEYS[j]] && dev[KEYS[j]]) f[KEYS[j]] = dev[KEYS[j]];
  }
  f._dev = dev;
  return f;
}

function uaOf(f) {
  var dev = f._dev || {}, ua = normalizeJDUserAgent(f["User-Agent"] || "");
  if (ua) return ua;
  if (dev.ua) return normalizeJDUserAgent(dev.ua);
  if (f.clientVersion && f.build) {
    return "jdapp;iPhone;" + f.clientVersion + ";;;M/5.0;appBuild/" + f.build +
      ";jdSupportDarkMode/0;lang/zh_CN;ctype/0;site/CN;ccy/CNY;elder/0;ef/1;supportJDSHWK/1;";
  }
  return "";
}

function missing(f, ua) {
  var m = [];
  if (!ua) m.push("User-Agent");
  ["uuid", "eid", "d_brand", "d_model", "osVersion", "build", "clientVersion"].forEach(function (k) {
    if (!f[k]) m.push(k === "eid" ? "x-api-eid-token" : k);
  });
  return m;
}

// 按用户指定格式输出字段。
var ORDER = ["pt_key", "pt_pin", "User-Agent", "uuid", "eid", "wg",
  "d_brand", "d_model", "osVersion", "build", "clientVersion"];

function compose(f) {
  var out = [], ua = uaOf(f);
  for (var i = 0; i < ORDER.length; i++) {
    var name = ORDER[i];
    var v = name === "User-Agent" ? ua
      : name === "eid" ? f.eid
      : name === "wg" ? f.wg
      : f[name] || "";
    if (name === "eid") name = "x-api-eid-token";
    if (name === "wg") name = "wg-sdk-token";
    v = String(v || "").replace(/^\s+|\s+$/g, "");
    if (v) out.push(name + "=" + v);
  }
  /* 统一版：pin# 前缀 + 占位网页指纹键。
     172 的 enriched() 只看 3AB9D23F7A4B3C9B= 在不在；带上它 172 就跳过
     浏览器补指纹和 env 回写，App UA（含分号）不会被 warm_fp.js 拆碎。 */
  var full = out.join(";");
  if (/^jdapp;/.test(ua) && /uuid=/.test(full) && /x-api-eid-token=/.test(full)) {
    out.push("3AB9D23F7A4B3C9B=appfull");
  }
  return (f.pt_pin || "") + "#" + out.join(";") + ";";
}

/* ---------------- 青龙 OpenAPI ---------------- */

function httpCall(method, url, token, body) {
  return new Promise(function (resolve, reject) {
    var headers = { "Accept": "application/json" };
    var opts = { url: url, headers: headers, timeout: 15000 };
    /* ★ Loon 脚本的 $httpClient 默认走 DIRECT，不会走 Rule 里的 Tailscale 分流；
       panel 是 tailnet IP，必须显式指定 node 才能到达。 */
    if (CFG.node) opts.node = CFG.node;
    if (body != null) {
      opts.body = body;
      headers["Content-Type"] = "application/json";
    }
    if (token) headers["Authorization"] = "Bearer " + token;
    var cb = function (err, resp, data) {
      if (err) return reject(new Error("网络错误：" + err));
      var json = null;
      if (data && typeof data === "object") json = data;
      else { try { json = JSON.parse(data); } catch (e) {} }
      resolve({
        status: (resp && (resp.status || resp.statusCode)) || 0,
        json: json,
        raw: typeof data === "string" ? data : ""
      });
    };
    if (method === "GET") $httpClient.get(opts, cb);
    else if (method === "PUT") {
      if (typeof $httpClient.put === "function") $httpClient.put(opts, cb);
      else $httpClient.post(opts, cb);
    } else $httpClient.post(opts, cb);
  });
}

function base() {
  return String(CFG.panel || "").replace(/^\s+|\s+$/g, "").replace(/\/+$/, "");
}
function api(path, method, token, body) {
  return httpCall(method, base() + path, token, body);
}
function ok(r, what) {
  var j = r.json || {};
  if (r.status >= 200 && r.status < 300 &&
      (j.code == null || j.code === 0 || j.code === 200)) return r;
  var m = (j.error || j.message || j.msg || r.raw || "").toString().slice(0, 160);
  throw new Error(what + "失败：HTTP " + r.status + " " + m);
}
function getToken() {
  if (!CFG.panel || CFG.panel.indexOf("填写") === 0) {
    return Promise.reject(new Error("请先配 panel —— Loon 的 [Script] argument 里写 panel=http://你的地址:5711"));
  }
  if (!CFG.clientId || !CFG.clientSecret ||
      CFG.clientId.indexOf("填写") === 0 || CFG.clientSecret.indexOf("填写") === 0) {
    return Promise.reject(new Error("请先填写青龙 OpenAPI Client ID 和 Client Secret"));
  }
  var path = "/open/auth/token?client_id=" + encodeURIComponent(CFG.clientId) +
    "&client_secret=" + encodeURIComponent(CFG.clientSecret);
  return api(path, "GET", null).then(function (r) {
    ok(r, "获取青龙 Token");
    var d = (r.json && r.json.data) || {};
    var t = d.token || d.access_token;
    if (!t) throw new Error("青龙未返回 Token，请检查应用密钥");
    return t;
  });
}
function listEnvs(token, envName) {
  envName = envName || ENV_NAME;
  return api("/open/envs?searchValue=" + encodeURIComponent(envName), "GET", token)
    .then(function (r) {
      ok(r, "读取青龙环境变量 " + envName);
      var a = (r.json || {}).data;
      if (a && !Array.isArray(a) && Array.isArray(a.data)) a = a.data;
      if (!Array.isArray(a)) throw new Error("青龙环境变量列表格式异常：" + envName);
      return a.filter(function (e) { return e && e.name === envName; });
    });
}
function split(value) {
  return String(value || "").split(/[\n&]/).filter(function (s) {
    return s.indexOf("pt_key=") >= 0 && s.indexOf("pt_pin=") >= 0;
  });
}
function findPin(envs, pin) {
  for (var i = 0; i < envs.length; i++) {
    var parts = split(envs[i].value);
    for (var j = 0; j < parts.length; j++) {
      if (cval(parts[j], "pt_pin") === pin) return envs[i];
    }
  }
  return null;
}
function saveEnv(token, hit, cookie, pin) {
  /* 多账号铁律：同号替换、异号追加，绝不整条覆盖。
     hit 可能是同 pin 的行，env 里还有别的号 —— 必须保留其它行。 */
  var old = String((hit && hit.value) || "");
  var lines = split(old).filter(function (x) { return cval(x, "pt_pin") !== pin; });
  lines.push(cookie);
  var value = lines.join("\n");
  if (hit) {
    return api("/open/envs", "PUT", token, JSON.stringify({
      id: hit.id, name: ENV_NAME, value: value, remarks: pin
    })).then(function (r) {
      ok(r, "更新青龙环境变量");
      return { action: "已更新", id: hit.id, status: hit.status };
    });
  }
  return api("/open/envs", "POST", token, JSON.stringify([{
    name: ENV_NAME, value: value, remarks: pin
  }])).then(function (r) {
    ok(r, "新增青龙环境变量");
    var d = (r.json && r.json.data) || [];
    var item = Array.isArray(d) ? d[0] : d;
    return {
      action: "已新增",
      id: item && item.id,
      status: item && item.status
    };
  });
}
function enableEnv(token, id) {
  if (id == null) return Promise.reject(new Error("无法取得环境变量 ID，不能确认启用状态"));
  return api("/open/envs/enable", "PUT", token, JSON.stringify([id]))
    .then(function (r) { ok(r, "启用青龙环境变量"); return true; });
}

// JD_USER_AGENT 是青龙全局变量：只保存真实京东 App 请求头中的完整 UA，变化时才更新。
function upsertUserAgent(token, ua) {
  ua = normalizeJDUserAgent(ua);
  if (!ua) {
    return Promise.resolve({ changed: false, skipped: true });
  }
  return listEnvs(token, UA_ENV_NAME).then(function (envs) {
    var hit = envs.length ? envs[0] : null;
    if (hit && String(hit.value || "") === ua) return { changed: false, skipped: false };
    if (hit) {
      return api("/open/envs", "PUT", token, JSON.stringify({
        id: hit.id, name: UA_ENV_NAME, value: ua, remarks: "京东 App 自动采集"
      })).then(function (r) {
        ok(r, "更新 JD_USER_AGENT");
        return { changed: true, skipped: false };
      });
    }
    return api("/open/envs", "POST", token, JSON.stringify([{
      name: UA_ENV_NAME, value: ua, remarks: "京东 App 自动采集"
    }])).then(function (r) {
      ok(r, "新增 JD_USER_AGENT");
      return { changed: true, skipped: false };
    });
  });
}

/* 守护豆田定位：写 JD_LOCATION，格式 pin#area#lng#lat（多账号换行，同号替换）。
   只在 f.area/f.lng/f.lat 都有时才写；占位符"待Loon写入"会被替换掉。 */
function upsertLocation(token, pin, area, lng, lat) {
  if (!pin || !area || !lng || !lat) return Promise.resolve({ changed: false, skipped: true });
  var line = pin + "#" + area + "#" + lng + "#" + lat;
  return listEnvs(token, LOC_ENV_NAME).then(function (envs) {
    var hit = envs.length ? envs[0] : null;
    var old = String((hit && hit.value) || "");
    // 保留其它账号行，只替换同 pin 的
    var lines = old.split(/[\n&]/).filter(function (x) {
      return x && x.indexOf(pin + "#") !== 0;
    });
    lines.push(line);
    var value = lines.join("\n");
    if (old === value) return { changed: false, skipped: false };
    if (hit) {
      return api("/open/envs", "PUT", token, JSON.stringify({
        id: hit.id, name: LOC_ENV_NAME, value: value, remarks: "京东 App 自动采集定位"
      })).then(function (r) { ok(r, "更新 JD_LOCATION"); return { changed: true, skipped: false }; });
    }
    return api("/open/envs", "POST", token, JSON.stringify([{
      name: LOC_ENV_NAME, value: value, remarks: "京东 App 自动采集定位"
    }])).then(function (r) { ok(r, "新增 JD_LOCATION"); return { changed: true, skipped: false }; });
  });
}

function queryBean(ua, key, pin) {
  return new Promise(function (resolve) {
    $httpClient.get({
      url: "https://me-api.jd.com/user_new/info/GetJDUserInfoUnion?orgFlag=JD_PinGou_New&callSource=mainorder&channel=4&isHomewhite=0&sceneval=2",
      headers: {
        Cookie: "pt_key=" + key + ";pt_pin=" + pin + ";",
        Referer: "https://home.m.jd.com/myJd/newhome.action?sceneval=2&ufc=&",
        "User-Agent": ua || "jdapp;iPhone;15.0.0;;;M/5.0;appBuild/100000;"
      },
      timeout: 8000
    }, function (err, resp, data) {
      if (err) return resolve("查询失败");
      var j = null;
      try { j = JSON.parse(data); } catch (e) { return resolve("解析失败"); }
      var rc = String(j.retcode);
      if (rc === "1001") return resolve("CK 已失效");
      if (rc !== "0") return resolve("查询失败(" + rc + ")");
      var n = j.data && j.data.assetInfo && j.data.assetInfo.beanNum;
      resolve(n == null ? "CK 有效" : n + " 京豆");
    });
  });
}

function push(f, cookie) {
  var pin = f.pt_pin, ua = uaOf(f), token = "";
  var action = "", envId = null, envStatus = null, uaResult = { changed: false };
  return getToken().then(function (t) {
    token = t;
    return listEnvs(token, ENV_NAME);
  }).then(function (envs) {
    var hit = findPin(envs, pin);
    // CK 内容完全相同则不重复写入，避免京东每个接口都触发青龙更新。
    if (hit && String(hit.value || "") === cookie) {
      action = "未变化";
      envId = hit.id;
      envStatus = hit.status;
      return { action: action, id: envId, status: envStatus, unchanged: true };
    }
    return saveEnv(token, hit, cookie, pin);
  }).then(function (saved) {
    action = saved.action;
    envId = saved.id;
    envStatus = saved.status;
    if (saved.unchanged) return true;
    if (envStatus === 1 || envStatus === "1") return enableEnv(token, envId);
    if (envStatus === 0 || envStatus === "0") return true;
    return listEnvs(token, ENV_NAME).then(function (envs) {
      var hit = findPin(envs, pin);
      if (!hit) throw new Error("写入后未能在青龙中找到该账号");
      if (hit.status === 1 || hit.status === "1") return enableEnv(token, hit.id);
      return true;
    });
  }).then(function (enabled) {
    // UA 与 CK 一起同步；仅真实 jdapp UA，且仅内容变化时写入。
    return upsertUserAgent(token, ua).then(function (r) {
      uaResult = r;
      if (action === "未变化" && uaResult.changed) action = "UA 已更新";
      return enabled;
    });
  }).then(function (enabled) {
    // 守护豆田定位：有经纬度时写 JD_LOCATION
    return upsertLocation(token, pin, f.area, f.lng, f.lat).then(function () { return enabled; });
  }).then(function (enabled) {
    if (!CFG.pushBean || action === "未变化") return { enabled: enabled, bean: "" };
    return queryBean(ua, f.pt_key, pin).then(function (bean) {
      return { enabled: enabled, bean: bean };
    });
  }).then(function (r) {
    var nick = pin;
    try { nick = decodeURIComponent(pin); } catch (e) {}
    var lines = [action + (r.enabled ? " · 已启用" : " · 未启用，请去青龙面板检查")];
    if (uaResult.changed) lines.push("JD_USER_AGENT 已自动" + (uaResult.skipped ? "跳过" : "更新"));
    lines.push("设备：" + (f.d_model || "?") + " / iOS " + (f.osVersion || "?") + " / App " + (f.clientVersion || "?"));
    var loc = [];
    if (!f.area) loc.push("area");
    if (!f.lng) loc.push("lng");
    if (!f.lat) loc.push("lat");
    if (loc.length) lines.push("定位未齐：" + loc.join(",") + "（守护豆田可能跳过）");
    if (!f.wg) lines.push("缺 wg-sdk-token（守护豆田可能跳过，打开一次种豆得豆即可尝试补齐）");
    if (r.bean) lines.push("京豆：" + r.bean);
    // 每个账号单独通知冷却；CK 未变化且 UA 未变化时不通知。
    /* 现状（老大 11-24 定）：CK 真变了或 UA 变了才通知；10 分钟每账号冷却，不吵 */
    var noticeKey = "jdck_notice_" + hash(pin);
    var lastNotice = parseInt($persistentStore.read(noticeKey) || "0", 10) || 0;
    var meaningful = action !== "未变化" || uaResult.changed;
    if (CFG.notify && meaningful && Date.now() - lastNotice >= NOTIFY_GAP_MS) {
      $notification.post("京东 CK 同步青龙", nick, lines.join("\n"));
      $persistentStore.write(String(Date.now()), noticeKey);
    }
    log("青龙" + action + " " + nick + " / UA变化=" + !!uaResult.changed + " / " + (r.bean || ""));
    return r;
  });
}

/* ---------------- 入口 ---------------- */

var finished = false, pushPending = false, pushSettled = false;
function finish() {
  if (finished) return;
  finished = true;
  if (pushPending && !pushSettled) {
    $persistentStore.write(String(Date.now() + DOWN_COOL_MIN * 60000), "jdck_down");
    log("推送超时，进入冷却");
  }
  $done({});
}
setTimeout(finish, MAX_HOLD_MS);

function hash(s) {
  var h = 5381;
  for (var i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

function sigOf(f) {
  return hash([f.pt_pin, f.uuid, f.openudid, f.eid, f.wg, f.d_brand, f.d_model,
    f.osVersion, f.build, f.clientVersion, f.screen, f.partner, f.area, f.lng, f.lat,
    (f._dev && f._dev.ua) ? "R" : "S"].join("|"));
}

(function main() {
  var req = typeof $request !== "undefined" ? $request : {};
  log("触发 host=" + hostOf(req.url) + " url=" + String(req.url || "").slice(0, 90));
  seedDevFromArg();
  var f = mergeDev(collect(req));

  if (!f.pt_key || !f.pt_pin) { log("跳过：Cookie 无 pt_key/pt_pin（需 MITM 解密京东 App）"); return finish(); }
  if (!PUSH_HOSTS[hostOf(req.url)]) { log("跳过：host 非 api.m/sh.jd.com"); return finish(); }
  if (Date.now() < (parseInt($persistentStore.read("jdck_down") || "0", 10) || 0)) return finish();

  var ua = uaOf(f), miss = missing(f, ua);
  if (miss.length) {
    log("设备信息未齐，继续等待：" + miss.join(","));
    return finish();
  }

  var cookie = compose(f), sig = sigOf(f);
  var lastSig = $persistentStore.read("jdck_sig") || "";
  var lastAt = parseInt($persistentStore.read("jdck_at") || "0", 10) || 0;
  if (sig === lastSig && Date.now() - lastAt < (CFG.minGapMin || 1) * 60000) return finish();

  $persistentStore.write(sig, "jdck_sig");
  $persistentStore.write(String(Date.now()), "jdck_at");

  var loc = [];
  if (!f.area) loc.push("area");
  if (!f.lng) loc.push("lng");
  if (!f.lat) loc.push("lat");
  log("发现完整 CK：" + f.pt_pin + (loc.length ? "（缺定位：" + loc.join(",") + "）" : "") + "，开始推送");

  pushPending = true;
  push(f, cookie).then(function () {
    pushSettled = true;
    $persistentStore.write("0", "jdck_down");
    finish();
  }).catch(function (e) {
    pushSettled = true;
    $persistentStore.write(String(Date.now() + DOWN_COOL_MIN * 60000), "jdck_down");
    log("推送失败（" + DOWN_COOL_MIN + " 分钟内不再尝试）：" + (e && e.message));
    if (CFG.notify) $notification.post("京东 CK 推送失败", f.pt_pin, String((e && e.message) || e));
    finish();
  });
})();
