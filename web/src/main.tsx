import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import './styles.css';
import { Gallery } from './views/Gallery';
import { setPublicMode, STATIC } from './api';
import { Dashboard } from './views/Dashboard';
import { Revisit } from './views/Revisit';
import { Showcase } from './views/Showcase';
import { Viewer } from './views/Viewer';

/** Hash routes, so the guide can serve this app as plain static files: #/ and #/capture/<id>. */
function App() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const onChange = () => setHash(location.hash);
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  // Visitors never need a key: the front page and #/p/<id> read only /public.
  const visitor = /^#\/p\/([0-9a-f-]{36})$/i.exec(hash);
  const front = !hash.startsWith('#/') || hash === '#/';   // '#how' and other anchors stay on the front page
  if (!STATIC) setPublicMode(Boolean(visitor) || front);
  if (visitor) return <Viewer key={visitor[1]} id={visitor[1]} publicView />;
  if (front || STATIC) return <Showcase />;   // a static site has no family tools

  const capture = /^#\/capture\/([0-9a-f-]{36})$/i.exec(hash);
  const revisit = /^#\/revisit\/([0-9a-f-]{36})$/i.exec(hash);
  if (revisit) return <Revisit key={revisit[1]} id={revisit[1]} />;
  const dashboard = /^#\/dashboard\/([0-9a-f-]{36})$/i.exec(hash);
  if (dashboard) return <Dashboard key={dashboard[1]} id={dashboard[1]} />;
  return capture ? <Viewer key={capture[1]} id={capture[1]} /> : <Gallery />;   // #/captures and anything else
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
