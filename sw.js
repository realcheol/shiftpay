/* ══════════════════════════════════════════════════════════════════════
   ShiftPay 웹 — PWA 오프라인 Service Worker (v1.6.0 · 2조 2교대 패턴 정정)
   ──────────────────────────────────────────────────────────────────────
   · 정적 에셋(앱 화면·아이콘·피코 이미지)은 install 단계에서 미리 캐시
   · index.html / version.json 은 Network-First
       → 새 업데이트가 막히지 않고, 인터넷이 끊기면 캐시본으로 앱 실행
   · downloads/ (APK·ZIP·HWP 대용량) 와 외부 도메인 요청은 가로채지 않고 통과
   · activate 에서 이전 버전 캐시 자동 삭제 + clients.claim()
   ══════════════════════════════════════════════════════════════════════ */
const CACHE_PREFIX = 'shiftpay';
const CACHE_VERSION = 'v1.6.0-20261115b';   // 화면/에셋을 바꿔 배포할 때 이 문자열을 올린다
const STATIC_CACHE = `${CACHE_PREFIX}-static-${CACHE_VERSION}`;
const RUNTIME_CACHE = `${CACHE_PREFIX}-runtime-${CACHE_VERSION}`;
const KEEP_CACHES = [STATIC_CACHE, RUNTIME_CACHE];

// 미리 캐시할 정적 에셋 (없는 파일이 하나 있어도 나머지는 계속 캐시)
const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.json',
  './version.json',
  './favicon.ico',
  './favicon-16x16.png',
  './favicon-32x32.png',
  './favicon-48x48.png',
  './apple-touch-icon.png',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable.png',
  './icon-maskable-192.png',
  './icon.png',
  './pico/pico_safety_full.png',
  './pico/pico_wave.png',
  './pico/pico_splash.gif',
  './factories/factory_1.jpg',
  './factories/factory_2.jpg',
  './factories/factory_3.jpg'
];

// ── install: 프리캐시 + 즉시 활성화 대기 ──────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(STATIC_CACHE);
    await Promise.all(PRECACHE_URLS.map(async (url) => {
      try {
        // cache: 'reload' 로 HTTP 캐시를 건너뛰고 새 파일을 받아 둔다
        const res = await fetch(url, { cache: 'reload' });
        if (res && (res.ok || res.type === 'opaque')) await cache.put(url, res.clone());
      } catch (e) { /* 개별 실패는 무시 */ }
    }));
    await self.skipWaiting();
  })());
});

// ── activate: 이전 버전 캐시 정리 + 바로 제어권 획득 ───────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((k) => k.startsWith(CACHE_PREFIX) && KEEP_CACHES.indexOf(k) < 0)
      .map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// 페이지에서 새 버전으로 교체를 요청할 때
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

// ── 헬퍼 ────────────────────────────────────────────────────────────
function isCacheable(res) {
  return !!res && (res.ok || res.type === 'opaque') && res.status !== 206;
}

// Network-First: 네트워크 우선 → 성공하면 캐시 갱신, 실패하면 캐시본
async function networkFirst(request, cacheKey, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    // no-cache: 서버에 재검증(변경 없으면 304) → 새 배포가 즉시 반영된다
    const res = await fetch(request, { cache: 'no-cache' });
    if (isCacheable(res)) {
      try { await cache.put(cacheKey, res.clone()); } catch (e) {}
      return res;
    }
    throw new Error('bad-response');
  } catch (e) {
    const hit = await cache.match(cacheKey, { ignoreSearch: true });
    if (hit) return hit;
    const anyHit = await caches.match(request, { ignoreSearch: true });
    if (anyHit) return anyHit;
    if (request.mode === 'navigate') {
      const shell = await caches.match('./index.html', { ignoreSearch: true });
      if (shell) return shell;
      return new Response(
        '<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8">'
        + '<meta name="viewport" content="width=device-width, initial-scale=1">'
        + '<title>ShiftPay 오프라인</title></head>'
        + '<body style="font-family:sans-serif;padding:32px;text-align:center;color:#0f172a;">'
        + '<h2>인터넷에 연결되어 있지 않습니다</h2>'
        + '<p style="color:#64748b;line-height:1.6;">한 번 이상 접속한 뒤에는<br>오프라인에서도 ShiftPay가 열립니다.</p>'
        + '</body></html>',
        { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
      );
    }
    return new Response('offline', { status: 503, statusText: 'offline' });
  }
}

// Cache-First (없으면 네트워크 → 런타임 캐시에 저장)
async function cacheFirst(request) {
  const cached = await caches.match(request, { ignoreSearch: true });
  if (cached) return cached;
  try {
    const res = await fetch(request);
    if (isCacheable(res) && request.url.startsWith(self.location.origin)) {
      const cache = await caches.open(RUNTIME_CACHE);
      try { await cache.put(request, res.clone()); } catch (e) {}
    }
    return res;
  } catch (e) {
    return new Response('offline', { status: 503, statusText: 'offline' });
  }
}

// ── fetch ───────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;                       // POST 등은 그대로 통과

  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  if (url.origin !== self.location.origin) return;         // 외부 도메인(구글 폰트·링크 등) 통과
  if (url.pathname.indexOf('/downloads/') >= 0) return;   // APK·ZIP·HWP 대용량 파일 통과

  const isNavigation = req.mode === 'navigate';
  const isIndexHtml = url.pathname.endsWith('/index.html') || url.pathname.endsWith('/');
  const isVersion = url.pathname.endsWith('/version.json');
  const isManifest = url.pathname.endsWith('/manifest.json');

  if (isNavigation || isIndexHtml) {
    event.respondWith(networkFirst(req, './index.html', STATIC_CACHE));
    return;
  }
  if (isVersion || isManifest) {
    const key = isVersion ? './version.json' : './manifest.json';
    event.respondWith(networkFirst(req, key, STATIC_CACHE));
    return;
  }
  event.respondWith(cacheFirst(req));
});
