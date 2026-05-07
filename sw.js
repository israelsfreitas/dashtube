const CACHE_NAME = 'dashtube-cache-v1';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  'https://cdn.jsdelivr.net/npm/sortablejs@1.15.2/Sortable.min.js'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        return cache.addAll(ASSETS_TO_CACHE);
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cache => {
          if (cache !== CACHE_NAME) {
            return caches.delete(cache);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  // Ignorar requisições da API do YouTube (elas são tratadas no app.js com fetch try/catch e localStorage)
  if (event.request.url.includes('googleapis.com/youtube')) {
    return;
  }

  event.respondWith(
    caches.match(event.request)
      .then(response => {
        // Retorna do cache se encontrado
        if (response) {
          // Em background, tenta atualizar o cache (Stale-While-Revalidate simples)
          fetch(event.request).then(netResponse => {
            if (netResponse && netResponse.status === 200) {
              caches.open(CACHE_NAME).then(cache => {
                cache.put(event.request, netResponse);
              });
            }
          }).catch(() => {}); // Ignora falhas de rede em background
          
          return response;
        }

        // Se não está no cache, tenta buscar na rede
        return fetch(event.request).then(netResponse => {
          // Faz cache da nova resposta se for válida
          if (netResponse && netResponse.status === 200 && netResponse.type === 'basic') {
            const responseToCache = netResponse.clone();
            caches.open(CACHE_NAME).then(cache => {
              cache.put(event.request, responseToCache);
            });
          }
          return netResponse;
        }).catch(() => {
          // Fallback offline (opicional, já que as requisições principais estão cacheadas)
        });
      })
  );
});
