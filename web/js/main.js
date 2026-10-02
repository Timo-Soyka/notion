// Einstieg: normale App oder Druckansicht (für die PDF-Fassung).

import { App } from './app/app.js';
import { isPad } from './bridge.js';
import { installTouch } from './touch.js';

const params = new URLSearchParams(location.search);

if (params.has('print')) {
  import('./print.js').then(m => m.renderPrint(params.get('print')));
} else {
  if (isPad) installTouch();
  const app = new App(document.getElementById('root'));
  window.heftApp = app;
  app.boot();
}
