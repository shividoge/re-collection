import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import './styles.css';
import { Gallery } from './views/Gallery';
import { Viewer } from './views/Viewer';

/** Hash routes, so the guide can serve this app as plain static files: #/ and #/capture/<id>. */
function App() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const onChange = () => setHash(location.hash);
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  const capture = /^#\/capture\/([0-9a-f-]{36})$/i.exec(hash);
  return capture ? <Viewer key={capture[1]} id={capture[1]} /> : <Gallery />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
