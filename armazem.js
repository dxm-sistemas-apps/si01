/* ============================================================================
   ARMAZEM.JS — armazenamento local SEM LIMITE prático (IndexedDB) para o Sistema Integrado DETRAN.RJ
   ----------------------------------------------------------------------------
   - Substitui o localStorage (limite de ~5 MB) por IndexedDB, mantendo a mesma forma de uso:
       Armazem.ls.getItem / setItem / removeItem   (síncronos, lendo de um cache em memória)
   - PDFs do histórico (historico_pdfs_*) são guardados como arquivos (Blob) separados,
     e a lista guarda só os dados leves (nome, empresa, data...).
   - Os scripts principais das páginas são marcados com type="text/armazem" e só são executados
     depois que os dados foram carregados (assim cada página já nasce com tudo preenchido).
   - Se o arquivo firebase-config.js estiver preenchido, o nuvem.js é carregado e sincroniza
     tudo com o Firebase (Firestore + Storage). Sem configuração, tudo funciona só no aparelho.
   ============================================================================ */
(function () {
    'use strict';
    if (window.Armazem) return;

    var PADRAO_CHAVES = /^(historico_pdfs_|rascunho_|detran_)/;
    var PADRAO_HIST = /^historico_pdfs_/;
    var DB_NOME = 'sistema-integrado-v1';

    var scriptAtual = document.currentScript;
    var BASE = (scriptAtual && scriptAtual.src) ? scriptAtual.src.replace(/[^\/]*$/, '') : '';

    var cache = new Map();   // chave -> texto
    var tempos = new Map();  // chave -> carimbo de tempo da última alteração
    var semIDB = false;
    var falhas = 0;
    var interagiu = false;

    /* ---------------------------- IndexedDB ---------------------------- */
    var dbPromise = null;
    function abrirDB() {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise(function (ok, erro) {
            if (!window.indexedDB) return erro(new Error('IndexedDB indisponível'));
            var limite = setTimeout(function () { erro(new Error('IndexedDB demorou demais')); }, 4000);
            var r;
            try { r = indexedDB.open(DB_NOME, 1); } catch (e) { clearTimeout(limite); return erro(e); }
            r.onupgradeneeded = function () {
                var db = r.result;
                if (!db.objectStoreNames.contains('ls')) db.createObjectStore('ls');
                if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
            };
            r.onsuccess = function () { clearTimeout(limite); ok(r.result); };
            r.onerror = function () { clearTimeout(limite); erro(r.error); };
            r.onblocked = function () { clearTimeout(limite); erro(new Error('IndexedDB bloqueado')); };
        });
        return dbPromise;
    }

    function idb(store, modo, fn) {
        return abrirDB().then(function (db) {
            return new Promise(function (ok, erro) {
                var t = db.transaction(store, modo);
                var req = fn(t.objectStore(store));
                t.oncomplete = function () { ok(req ? req.result : undefined); };
                t.onerror = function () { erro(t.error); };
                t.onabort = function () { erro(t.error); };
            });
        });
    }

    var fila = Promise.resolve();
    function enfileirar(fn) {
        var p = fila.then(fn).then(function () { return true; }, function (e) {
            falhas++;
            console.warn('[Armazem] falha ao gravar:', e);
            return false;
        });
        fila = p;
        return p;
    }

    function lerTodos() {
        return abrirDB().then(function (db) {
            return new Promise(function (ok, erro) {
                var out = {};
                var t = db.transaction('ls', 'readonly');
                var c = t.objectStore('ls').openCursor();
                c.onsuccess = function () {
                    var cur = c.result;
                    if (cur) { out[cur.key] = cur.value; cur.continue(); }
                };
                t.oncomplete = function () { ok(out); };
                t.onerror = function () { erro(t.error); };
            });
        });
    }

    /* ---------------------------- Utilidades ---------------------------- */
    function dataUriParaBlob(u) {
        var p = String(u).split(',');
        var mime = ((p[0].match(/:(.*?);/) || [])[1]) || 'application/pdf';
        var bin = atob(p[1] || '');
        var b = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
        return new Blob([b], { type: mime });
    }

    function blobParaDataUri(blob) {
        return new Promise(function (ok, erro) {
            var r = new FileReader();
            r.onloadend = function () { ok(r.result); };
            r.onerror = function () { erro(r.error); };
            r.readAsDataURL(blob);
        });
    }

    function lerLista(k) {
        try {
            var a = JSON.parse(cache.get(k));
            return Array.isArray(a) ? a : [];
        } catch (_) { return []; }
    }

    /* Ids excluídos (lápides) de cada lista de histórico — usado na mesclagem com a nuvem */
    function excluidos(k) {
        try {
            var a = JSON.parse(cache.get('__del:' + k));
            return new Set(Array.isArray(a) ? a.map(String) : []);
        } catch (_) { return new Set(); }
    }
    function salvarExcluidos(k, set) {
        var arr = Array.from(set).slice(-3000);
        var v = JSON.stringify(arr);
        cache.set('__del:' + k, v);
        if (semIDB) return;
        enfileirar(function () { return idb('ls', 'readwrite', function (s) { return s.put({ v: v, t: Date.now() }, '__del:' + k); }); });
    }
    function addExcluido(k, id) {
        var s = excluidos(k);
        s.add(String(id));
        salvarExcluidos(k, s);
    }

    /* ---------------------------- Blobs (PDFs) ---------------------------- */
    function guardarBlob(bk, blob, k, enviarNuvem) {
        enfileirar(function () { return idb('blobs', 'readwrite', function (s) { return s.put(blob, bk); }); });
        if (enviarNuvem && A.nuvem) A.nuvem.enviarBlob(bk, blob, k);
    }

    function apagarBlob(item, local) {
        var bk = item && item._bk;
        if (!bk) return;
        if (!semIDB) enfileirar(function () { return idb('blobs', 'readwrite', function (s) { return s.delete(bk); }); });
        if (local && A.nuvem) A.nuvem.removerBlob(bk);
    }

    function obterBlobLocal(bk) {
        if (!bk || semIDB) return Promise.resolve(null);
        return fila.then(function () {
            return idb('blobs', 'readonly', function (s) { return s.get(bk); });
        }).then(function (b) { return b || null; }, function () { return null; });
    }

    function obterBlob(bk) {
        return obterBlobLocal(bk).then(function (b) {
            if (b) return b;
            if (!bk || !A.nuvem) return null;
            return A.nuvem.baixarBlob(bk).then(function (nb) {
                if (nb && !semIDB) guardarBlob(bk, nb, null, false); // guarda cópia local (sem reenviar)
                return nb || null;
            }, function () { return null; });
        });
    }

    /* Completa um item do histórico com o dataUri (lido do Blob guardado) */
    function completar(obj) {
        if (!obj || obj.dataUri) return Promise.resolve(obj);
        return obterBlob(obj._bk).then(function (b) {
            if (!b) return obj;
            return blobParaDataUri(b).then(function (u) { obj.dataUri = u; return obj; });
        });
    }

    /* Devolve o Blob do PDF de um item do histórico */
    function blobDe(obj) {
        if (!obj) return Promise.resolve(null);
        if (obj.blob instanceof Blob) return Promise.resolve(obj.blob);
        if (obj.dataUri) return Promise.resolve(dataUriParaBlob(obj.dataUri));
        return obterBlob(obj._bk);
    }

    /* ---------------------------- Gravação ---------------------------- */
    function processarHistorico(k, v, local) {
        var arr;
        try { arr = JSON.parse(v); } catch (_) { return v; }
        if (!Array.isArray(arr)) return v;
        var depois = new Set(arr.map(function (i) { return String(i && i.id); }));
        lerLista(k).forEach(function (i) {
            if (!depois.has(String(i.id))) {
                apagarBlob(i, local);
                addExcluido(k, i.id);
            }
        });
        arr.forEach(function (item) {
            if (!item || typeof item.dataUri !== 'string' || item.dataUri.indexOf('data:') !== 0) return;
            var bk = k + ':' + item.id;
            guardarBlob(bk, dataUriParaBlob(item.dataUri), k, local);
            item._bk = bk;
            delete item.dataUri;
        });
        return JSON.stringify(arr);
    }

    function gravar(k, v, local, t) {
        if (!semIDB && PADRAO_HIST.test(k)) v = processarHistorico(k, v, local);
        var tt = (t == null) ? Date.now() : t;
        cache.set(k, v);
        tempos.set(k, tt);
        if (semIDB) {
            try { localStorage.setItem(k, v); } catch (_) {}
        } else {
            enfileirar(function () { return idb('ls', 'readwrite', function (s) { return s.put({ v: v, t: tt }, k); }); });
        }
        if (local && A.nuvem) A.nuvem.agendar(k);
    }

    function remover(k, local, t) {
        var tt = (t == null) ? Date.now() : t;
        if (!semIDB && PADRAO_HIST.test(k)) lerLista(k).forEach(function (i) { apagarBlob(i, local); });
        cache.delete(k);
        tempos.set(k, tt);
        if (semIDB) {
            try { localStorage.removeItem(k); } catch (_) {}
        } else {
            enfileirar(function () { return idb('ls', 'readwrite', function (s) { return s.put({ removido: true, t: tt }, k); }); });
        }
        if (local && A.nuvem) A.nuvem.agendar(k);
    }

    var ls = {
        getItem: function (k) { return cache.has(k) ? cache.get(k) : null; },
        setItem: function (k, v) { gravar(String(k), String(v), true); },
        removeItem: function (k) { remover(String(k), true); }
    };

    /* Adiciona um PDF ao histórico: o arquivo vai para o armazenamento de Blobs e a lista guarda só os dados leves */
    function addPDF(chave, item, blob) {
        var it = Object.assign({}, item);
        delete it.blob;
        delete it.dataUri;
        it._bk = chave + ':' + it.id;
        var pronto = semIDB
            ? blobParaDataUri(blob).then(function (u) { it.dataUri = u; })
            : Promise.resolve().then(function () { guardarBlob(it._bk, blob, chave, true); });
        return pronto.then(function () {
            var lista = lerLista(chave);
            lista.unshift(it);
            ls.setItem(chave, JSON.stringify(lista));
            return it;
        });
    }

    /* ---------------------------- Migração do localStorage antigo ---------------------------- */
    function carregarNativo() {
        try {
            for (var i = 0; i < localStorage.length; i++) {
                var k = localStorage.key(i);
                if (PADRAO_CHAVES.test(k)) { cache.set(k, localStorage.getItem(k)); tempos.set(k, 0); }
            }
        } catch (_) {}
    }

    function migrarNativo() {
        var chaves = [];
        try { for (var i = 0; i < localStorage.length; i++) chaves.push(localStorage.key(i)); } catch (_) { return; }
        chaves.filter(function (k) { return PADRAO_CHAVES.test(k); }).forEach(function (k) {
            try {
                var v = localStorage.getItem(k);
                if (v === null) return;
                var f0 = falhas;
                if (!cache.has(k)) gravar(k, v, false);
                enfileirar(function () { return true; }).then(function () {
                    if (falhas === f0) { try { localStorage.removeItem(k); } catch (_) {} }
                });
            } catch (_) {}
        });
    }

    function hidratar() {
        return abrirDB().then(lerTodos).then(function (tudo) {
            Object.keys(tudo).forEach(function (k) {
                var e = tudo[k] || {};
                tempos.set(k, e.t || 0);
                if (!e.removido && typeof e.v === 'string') cache.set(k, e.v);
            });
        }).catch(function (e) {
            console.warn('[Armazem] IndexedDB indisponível; usando localStorage.', e);
            semIDB = true;
            carregarNativo();
        }).then(function () {
            if (!semIDB) migrarNativo();
            try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (_) {}
        });
    }

    /* ---------------------------- Rascunho automático de campos ---------------------------- */
    function rascunhoCampos(chave, opts) {
        opts = opts || {};
        var pronto = false, timer = null, ignorarAte = 0;
        var ignorarIds = opts.ignorar || [];
        var ignorarPref = opts.ignorarPrefixos || [];

        function campos() {
            return Array.prototype.slice.call(document.querySelectorAll('input, select, textarea')).filter(function (e) {
                if (!e.id) return false;
                if (/^(file|button|submit|reset|image)$/.test(e.type)) return false;
                if (ignorarIds.indexOf(e.id) !== -1) return false;
                for (var i = 0; i < ignorarPref.length; i++) if (e.id.indexOf(ignorarPref[i]) === 0) return false;
                return true;
            });
        }
        function salvar() {
            if (!pronto) return;
            var d = { c: {}, x: opts.coletar ? opts.coletar() : {} };
            campos().forEach(function (e) {
                d.c[e.id] = (e.type === 'checkbox' || e.type === 'radio') ? e.checked : e.value;
            });
            ls.setItem(chave, JSON.stringify(d));
        }
        function agendar() {
            if (!pronto || Date.now() < ignorarAte) return;
            clearTimeout(timer);
            timer = setTimeout(salvar, 400);
        }
        function restaurar() {
            var bruto = ls.getItem(chave);
            if (bruto) {
                try {
                    var d = JSON.parse(bruto);
                    campos().forEach(function (e) {
                        if (!d.c || !(e.id in d.c)) return;
                        if (e.type === 'checkbox' || e.type === 'radio') e.checked = !!d.c[e.id];
                        else e.value = d.c[e.id];
                        e.dispatchEvent(new Event('input', { bubbles: true }));
                        e.dispatchEvent(new Event('change', { bubbles: true }));
                    });
                    if (opts.restaurar) opts.restaurar(d.x || {});
                } catch (e) { console.warn('[Armazem] erro ao restaurar rascunho', e); }
            }
            pronto = true;
        }
        function limpar() {
            clearTimeout(timer);
            ignorarAte = Date.now() + 800;
            ls.removeItem(chave);
        }
        document.addEventListener('input', agendar);
        document.addEventListener('change', agendar);
        window.addEventListener('pagehide', function () { clearTimeout(timer); if (Date.now() >= ignorarAte) salvar(); });
        document.addEventListener('visibilitychange', function () { if (document.hidden) { clearTimeout(timer); if (Date.now() >= ignorarAte) salvar(); } });
        return { salvar: salvar, agendar: agendar, restaurar: restaurar, limpar: limpar };
    }

    /* ---------------------------- Execução atrasada dos scripts das páginas ---------------------------- */
    function executarAtrasados() {
        var scripts = Array.prototype.slice.call(document.querySelectorAll('script[type="text/armazem"]'));
        if (!scripts.length) return;

        var jaCarregou = document.readyState === 'complete';
        var dclFila = [], loadFila = [], onloadFn = null;
        var addDoc = document.addEventListener, addWin = window.addEventListener;

        function capturar(alvo, orig) {
            return function (t, f, o) {
                if (t === 'DOMContentLoaded') { dclFila.push(f); return; }
                if (t === 'load' && jaCarregou) { loadFila.push(f); return; }
                return orig.call(alvo, t, f, o);
            };
        }
        document.addEventListener = capturar(document, addDoc);
        window.addEventListener = capturar(window, addWin);
        if (jaCarregou) {
            try { Object.defineProperty(window, 'onload', { configurable: true, get: function () { return onloadFn; }, set: function (f) { onloadFn = f; } }); } catch (_) {}
        }

        try {
            scripts.forEach(function (s) {
                var n = document.createElement('script');
                n.text = s.textContent;
                s.parentNode.insertBefore(n, s.nextSibling);
            });
        } finally {
            try { delete document.addEventListener; } catch (_) {}
            try { delete window.addEventListener; } catch (_) {}
            if (jaCarregou) { try { delete window.onload; } catch (_) {} }
        }

        function chamar(f, tipo) {
            try {
                var ev = new Event(tipo);
                if (typeof f === 'function') f.call(tipo === 'load' ? window : document, ev);
                else if (f && typeof f.handleEvent === 'function') f.handleEvent(ev);
            } catch (e) { console.error(e); }
        }
        dclFila.forEach(function (f) { chamar(f, 'DOMContentLoaded'); });
        if (jaCarregou) {
            loadFila.forEach(function (f) { chamar(f, 'load'); });
            if (typeof onloadFn === 'function') chamar(onloadFn, 'load');
        }
    }

    /* ---------------------------- Inicialização ---------------------------- */
    var A = window.Armazem = {
        ls: ls,
        addPDF: addPDF,
        completar: completar,
        blobDe: blobDe,
        obterBlob: obterBlob,
        blobParaDataUri: blobParaDataUri,
        dataUriParaBlob: dataUriParaBlob,
        rascunhoCampos: rascunhoCampos,
        falhas: function () { return falhas; },
        aguardarGravacao: function (f0) { return fila.then(function () { return falhas === f0; }); },
        nuvem: null,
        pronto: null,
        // uso interno (nuvem.js)
        _i: {
            base: BASE,
            padraoChaves: PADRAO_CHAVES,
            padraoHist: PADRAO_HIST,
            chaves: function () { return Array.from(cache.keys()).filter(function (k) { return PADRAO_CHAVES.test(k); }); },
            tempo: function (k) { return tempos.get(k) || 0; },
            lerLista: lerLista,
            excluidos: excluidos,
            addExcluidos: function (k, ids) { var s = excluidos(k); (ids || []).forEach(function (i) { s.add(String(i)); }); salvarExcluidos(k, s); },
            gravarRemoto: function (k, v, t) { gravar(k, v, false, t); },
            removerRemoto: function (k, t) { remover(k, false, t); },
            obterBlobLocal: obterBlobLocal,
            guardarBlob: guardarBlob,
            interagiu: function () { return interagiu; },
            semIDB: function () { return semIDB; }
        }
    };

    ['input', 'change', 'keydown', 'pointerdown'].forEach(function (t) {
        document.addEventListener(t, function () { interagiu = true; }, { capture: true, passive: true });
    });

    var domPronto = new Promise(function (ok) {
        if (document.readyState !== 'loading') ok();
        else document.addEventListener('DOMContentLoaded', function () { ok(); }, { once: true });
    });
    A.pronto = hidratar();

    Promise.all([A.pronto, domPronto]).then(function () {
        executarAtrasados();
        var cfg = window.FIREBASE_CONFIG;
        if (cfg && cfg.apiKey && !/COLE_AQUI/.test(cfg.apiKey)) {
            var s = document.createElement('script');
            s.src = BASE + 'nuvem.js';
            s.onerror = function () { console.warn('[Armazem] nuvem.js não encontrado; seguindo apenas com armazenamento local.'); };
            document.head.appendChild(s);
        }
    });
})();
