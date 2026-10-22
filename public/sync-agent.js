(function () {
  'use strict';

  if (window.__WEIWATCH_AGENT__) return;
  window.__WEIWATCH_AGENT__ = true;

  function baseHref() {
    var base = document.querySelector('base');
    return base && base.href ? base.href : location.href;
  }

  function post(type, data) {
    try {
      parent.postMessage(Object.assign({ source: 'weiwatch-agent', type: type }, data || {}), '*');
    } catch (error) {
      /* ignore */
    }
  }

  var currentTarget = baseHref();
  var lastUrl = currentTarget;

  function reportTarget(target, soft) {
    if (!target || target === lastUrl) return;
    lastUrl = target;
    currentTarget = target;
    post('navigate', { url: target, soft: Boolean(soft) });
  }

  function targetFromLocation() {
    // The proxied document lives at /proxy?url=...; only a hash change can
    // happen without a pushState, so map that back onto the real page.
    if (location.pathname === '/proxy' && location.search.indexOf('url=') !== -1) {
      try {
        return new URL(location.hash || '', baseHref()).toString();
      } catch (error) {
        return baseHref();
      }
    }
    try {
      return new URL(location.pathname + location.search + location.hash, baseHref()).toString();
    } catch (error) {
      return baseHref();
    }
  }

  document.addEventListener(
    'click',
    function (event) {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      var anchor = event.target && event.target.closest ? event.target.closest('a[href]') : null;
      if (!anchor) return;
      var href = anchor.getAttribute('href');
      if (!href || href.charAt(0) === '#' || /^javascript:/i.test(href)) return;
      if (anchor.target && anchor.target !== '_self') return;
      if (anchor.hasAttribute('download')) return;

      var url;
      try {
        url = new URL(anchor.href, baseHref());
      } catch (error) {
        return;
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

      event.preventDefault();
      event.stopPropagation();
      post('navigate', { url: url.toString() });
    },
    true
  );

  document.addEventListener(
    'submit',
    function (event) {
      var form = event.target;
      if (!form || !form.tagName || form.tagName.toLowerCase() !== 'form') return;
      var method = (form.getAttribute('method') || 'get').toLowerCase();
      if (method !== 'get') return;

      var action = form.getAttribute('action') || baseHref();
      var url;
      try {
        url = new URL(action, baseHref());
      } catch (error) {
        return;
      }

      try {
        new FormData(form).forEach(function (value, key) {
          if (typeof value === 'string') url.searchParams.set(key, value);
        });
      } catch (error) {
        /* ignore */
      }

      event.preventDefault();
      post('navigate', { url: url.toString() });
    },
    true
  );

  ['pushState', 'replaceState'].forEach(function (name) {
    var original = history[name];
    if (typeof original !== 'function') return;
    history[name] = function (state, title, url) {
      var result;
      try {
        result = original.apply(this, arguments);
      } catch (error) {
        // A page served through the proxy cannot push a URL on its own origin.
        // Report the intended URL to the parent instead of breaking the page.
        if (url != null) {
          try {
            reportTarget(new URL(String(url), currentTarget).toString(), true);
          } catch (inner) {
            /* ignore */
          }
        }
        return undefined;
      }
      if (url != null) {
        try {
          reportTarget(new URL(String(url), currentTarget).toString(), true);
        } catch (inner) {
          /* ignore */
        }
      }
      return result;
    };
  });

  window.addEventListener('popstate', function () {
    reportTarget(targetFromLocation(), true);
  });
  window.addEventListener('hashchange', function () {
    reportTarget(targetFromLocation(), true);
  });

  function attach(media) {
    if (!media || media.__weiwatchBound) return;
    media.__weiwatchBound = true;

    function send(action) {
      post('video', {
        action: action,
        time: media.currentTime || 0,
        paused: Boolean(media.paused),
        rate: media.playbackRate || 1,
        src: media.currentSrc || media.src || '',
      });
    }

    ['play', 'playing', 'pause', 'seeked', 'ratechange', 'ended'].forEach(function (name) {
      media.addEventListener(name, function () {
        send(name === 'playing' ? 'play' : name);
      });
    });
  }

  function scan() {
    var nodes = document.querySelectorAll('video, audio');
    for (var i = 0; i < nodes.length; i += 1) attach(nodes[i]);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scan);
  } else {
    scan();
  }

  try {
    new MutationObserver(scan).observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  } catch (error) {
    /* ignore */
  }

  post('ready', { url: baseHref(), title: document.title });
})();
