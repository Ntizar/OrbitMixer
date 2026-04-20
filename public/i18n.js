// Tiny i18n. AI answers always come back in Spanish from the server.
(function () {
  const dict = {
    es: {
      'src-mapbox': 'Mapbox Demo',
      'src-sentinel': 'Sentinel Free',
      'webcam-on':  'Activar webcam',
      'webcam-off': 'Desactivar webcam',
      'hm-map': 'Mapa',
      'hm-compare': 'Comparador',
      'hm-manual': 'Manual',
      'date-before': 'Antes',
      'date-now': 'Ahora',
      'hud-unlocked': 'SIN BLOQUEO',
      'hud-locked': 'BLOQUEADO',
      'cam-title': 'Webcam · gestos',
      'cam-off': 'Cámara desactivada. Pulsa Activar webcam en el mapa.',
      'mode-title': 'Modo de análisis',
      'm-veg': 'Vegetación', 'm-fire': 'Incendio', 'm-water': 'Agua', 'm-urban': 'Urbano', 'm-natural': 'Color natural',
      'l-rgb': 'RGB', 'l-dem': 'Elevación',
      'capture': 'Capturar y comparar',
      'split-title': 'Antes ↔ Ahora',
      'split-before': 'ANTES',
      'split-after': 'AHORA',
      'ai-title': 'Análisis IA',
      'ai-empty': 'Selecciona un punto en el mapa o sostén el pulgar arriba 5 s para comparar.',
      'ter-title': 'Territorio',
      'ter-place': 'Lugar', 'ter-region': 'Región', 'ter-country': 'País', 'ter-label': 'Etiqueta',
      'ai-real': 'IA real', 'ai-fallback': 'Fallback',
      'help-btn': 'Ayuda'
    },
    en: {
      'src-mapbox': 'Mapbox Demo',
      'src-sentinel': 'Sentinel Free',
      'webcam-on':  'Enable webcam',
      'webcam-off': 'Disable webcam',
      'hm-map': 'Map',
      'hm-compare': 'Compare',
      'hm-manual': 'Manual',
      'date-before': 'Before',
      'date-now': 'Now',
      'hud-unlocked': 'UNLOCKED',
      'hud-locked': 'LOCKED',
      'cam-title': 'Webcam · gestures',
      'cam-off': 'Camera off. Press Enable webcam on the map.',
      'mode-title': 'Analysis mode',
      'm-veg': 'Vegetation', 'm-fire': 'Fire', 'm-water': 'Water', 'm-urban': 'Urban', 'm-natural': 'Natural color',
      'l-rgb': 'RGB', 'l-dem': 'Elevation',
      'capture': 'Capture & compare',
      'split-title': 'Before ↔ Now',
      'split-before': 'BEFORE',
      'split-after': 'NOW',
      'ai-title': 'AI analysis',
      'ai-empty': 'Pick a point on the map or hold thumbs up for 5 s to compare.',
      'ter-title': 'Territory',
      'ter-place': 'Place', 'ter-region': 'Region', 'ter-country': 'Country', 'ter-label': 'Label',
      'ai-real': 'Real AI', 'ai-fallback': 'Fallback',
      'help-btn': 'Help'
    }
  };

  const I18N = {
    lang: 'es',
    t(key) { return (dict[this.lang] && dict[this.lang][key]) || key; },
    apply(root) {
      (root || document).querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        const v = this.t(key);
        if (v) el.textContent = v;
      });
    },
    setLang(lang) {
      if (!dict[lang]) return;
      this.lang = lang;
      document.documentElement.lang = lang;
      this.apply();
      document.dispatchEvent(new CustomEvent('lang:changed', { detail: { lang } }));
    }
  };
  window.I18N = I18N;
})();
