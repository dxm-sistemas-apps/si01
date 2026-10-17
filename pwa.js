/* ============================================================================
   PWA.JS — registra o app instalável e mostra o botão "INSTALAR APP"
   ============================================================================ */
(function () {
    'use strict';
    if (window.self !== window.top) return;                  // dentro do menu (iframe) do index: quem cuida é a página principal
    var standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;

    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
        window.addEventListener('load', function () {
            navigator.serviceWorker.register('sw.js').catch(function (e) { console.warn('[App] service worker não registrado', e); });
        });
    }

    if (standalone) return;                                   // já está instalado: sem botão
    try { if (sessionStorage.getItem('pwa_botao_fechado')) return; } catch (_) {}

    var ev = null, botao = null;
    var ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

    function criar() {
        if (botao || !document.body) return;
        botao = document.createElement('div');
        botao.className = 'no-print';
        botao.setAttribute('style',
            'position:fixed;right:12px;bottom:12px;z-index:40;display:flex;align-items:center;gap:6px;padding:6px 6px 6px 12px;' +
            'border-radius:999px;background:#000;color:#fff;font:700 11px/1.2 system-ui,Segoe UI,sans-serif;text-transform:uppercase;' +
            'letter-spacing:.04em;box-shadow:0 2px 8px rgba(0,0,0,.35);opacity:.95');
        var b = document.createElement('button');
        b.type = 'button';
        b.textContent = '⬇ INSTALAR APP';
        b.setAttribute('style', 'background:none;border:0;color:inherit;font:inherit;text-transform:inherit;letter-spacing:inherit;cursor:pointer;padding:0');
        b.addEventListener('click', instalar);
        var x = document.createElement('button');
        x.type = 'button';
        x.textContent = '✕';
        x.setAttribute('aria-label', 'Fechar');
        x.setAttribute('style', 'background:#333;border:0;color:#fff;border-radius:50%;width:20px;height:20px;font-size:10px;cursor:pointer;line-height:20px;padding:0');
        x.addEventListener('click', function () {
            try { sessionStorage.setItem('pwa_botao_fechado', '1'); } catch (_) {}
            botao.remove();
        });
        botao.appendChild(b); botao.appendChild(x);
        document.body.appendChild(botao);
    }

    function instalar() {
        if (ev) {
            ev.prompt();
            ev.userChoice.then(function () { ev = null; if (botao) { botao.remove(); botao = null; } });
            return;
        }
        var android = /android/i.test(navigator.userAgent);
        var msg = ios
            ? 'NO SAFARI, TOQUE EM <b>COMPARTILHAR</b> (QUADRADO COM SETA) E DEPOIS EM <b>ADICIONAR À TELA DE INÍCIO</b>. (NO IPHONE, SÓ O SAFARI INSTALA; DENTRO DE OUTROS APPS, ABRA O SITE NO SAFARI.)'
            : android
                ? 'NO CHROME, TOQUE NO MENU <b>⋮</b> E ESCOLHA <b>INSTALAR APLICATIVO</b> OU <b>ADICIONAR À TELA INICIAL</b>. SE NÃO APARECER, ABRA ESTE ENDEREÇO DIRETO NO CHROME (E NÃO DENTRO DO WHATSAPP/INSTAGRAM) E USE O SITE POR ALGUNS SEGUNDOS.'
                : 'NO CHROME OU EDGE, PROCURE O ÍCONE DE INSTALAR NO FINAL DA BARRA DE ENDEREÇOS (OU MENU <b>⋮</b> &gt; <b>INSTALAR</b>). O FIREFOX NO COMPUTADOR NÃO INSTALA APPS.';
        if (window.Swal) {
            Swal.fire({ title: 'INSTALAR O APP', html: '<span class="text-amber-500 font-bold">ATENÇÃO:</span> ' + msg, confirmButtonText: 'OK', confirmButtonColor: '#000000', returnFocus: false });
        } else {
            alert(msg.replace(/<[^>]+>/g, ''));
        }
    }

    window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); ev = e; criar(); });
    window.addEventListener('appinstalled', function () { ev = null; if (botao) { botao.remove(); botao = null; } });
    // O botão aparece sempre que o app ainda não está instalado (no iPhone/iPad e quando o navegador não avisa a instalação, mostra as instruções)
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', criar); else criar();
})();
