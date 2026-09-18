/* 旅行攻略 App 的 Service Worker。
 *
 * 🔴 为什么这个文件必须放在站点根目录，而不是 /trips/ 里面：
 *    Service Worker 的作用域（scope）**只能是它自己所在目录及以下**。
 *    App 壳在 /trips/，攻略页在 /nanjing/ 这种一级目录下 —— 放 /trips/sw.js 就管不到攻略页，
 *    「离线能看行程」这个唯一值钱的功能直接失效。GitHub Pages 又改不了响应头，
 *    所以没法用 Service-Worker-Allowed 把作用域撑大。只剩「放根目录」这一条路。
 *
 * ⚠️ 这个域名根目录还住着另一个项目（马培德食品的数字图册）。
 *    所以下面的 fetch 处理**默认放行**：只有旅行攻略相关的请求才接管，
 *    其余一律不调 respondWith，浏览器按原样走网络 —— 对那个项目完全没有副作用。
 *    判据写成「黑名单放行」而不是「白名单接管」，是为了让**以后新增的城市目录自动生效**，
 *    不用每加一座城市就回来改这个文件。代价：如果哪天根目录再进驻别的项目，
 *    要在 PASS_THROUGH 里加一条，否则会被误当成攻略页缓存起来。
 */

const VERSION = 'trips-v1';
const SHELL = [
  '/trips/',
  '/trips/index.html',
  '/trips/trips.json',
  '/trips/manifest.webmanifest',
  '/trips/icon-192.png',
  '/trips/icon-512.png',
];

// 这些路径属于根目录那个无关项目，一律不管
const PASS_THROUGH = [
  /^\/$/,
  /^\/index\.html$/,
  /^\/test\.html$/,
  /^\/README/i,
  /^\/css\//,
  /^\/image\//,
];

self.addEventListener('install', (e) => {
  // 预缓存只放 App 壳。攻略页不预缓存 —— 它们有图片，几 MB，
  // 装 App 的时候全拉一遍既慢又可能白拉（用户未必每座城市都看）。
  // 攻略页走「访问过一次就留下」的运行时缓存，见 fetch。
  e.waitUntil(
    caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* 给「这份内容是从缓存兜底来的」打个标记，让页面能如实告诉用户看到的可能是旧版本。
   ⚠️ 别指望页面用 navigator.onLine 自己判断 —— 实测（2026-09-18，CDP 模拟离线）
      导航之后它会变回 true；真实世界里更常见的是「连着 WiFi 但没有外网」，那时它也是 true。
      响应从哪来只有这里知道，所以判据放在这儿，不放页面。
   Response 的 headers 是只读的，要加头只能照原样重建一个。 */
function stamp(res) {
  if (!res) return res;
  const h = new Headers(res.headers);
  h.set('X-Offline-Cache', '1');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;          // 外链不管
  if (PASS_THROUGH.some((re) => re.test(url.pathname))) return;  // 别人的项目不管

  /* 策略：网络优先，失败回缓存。
     ⚠️ 别改成缓存优先：行程改得很勤（票价、预约时刻、分组随时在变），
        缓存优先会让人在有信号的时候还看着旧版本，而这份东西的错误是要误事的。
        网络优先的代价只是联网时慢一点点，值。 */
  e.respondWith(
    fetch(req)
      .then((res) => {
        // 只缓存正常的同源响应；opaque / 4xx / 5xx 不进缓存，免得把错误页固化下来
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then((hit) => {
          if (hit) return stamp(hit);
          // 离线且这个页面从没打开过 —— 导航请求退回 App 首页，至少能看到城市列表
          if (req.mode === 'navigate') return caches.match('/trips/index.html').then(stamp);
          return new Response('', { status: 504, statusText: 'offline' });
        })
      )
  );
});
