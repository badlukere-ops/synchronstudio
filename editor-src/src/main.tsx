import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { TooltipProvider } from './components/ui/tooltip.tsx';

function studioUnlocked(): boolean {
  try {
    const q = new URLSearchParams(location.search);
    if (q.get('studio') === '1') {
      localStorage.setItem('ss_editor_ok', '1');
      return true;
    }
    return localStorage.getItem('ss_editor_ok') === '1';
  } catch {
    return false;
  }
}

const rootEl = document.getElementById('root')!;

if (!studioUnlocked()) {
  rootEl.innerHTML = `
    <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0b0e;color:#eeeef2;font-family:Barlow,system-ui,sans-serif;padding:24px;text-align:center">
      <div style="max-width:420px">
        <h1 style="font-family:Anton,Impact,sans-serif;font-size:1.6rem;letter-spacing:.04em;margin:0 0 10px;text-transform:uppercase">Szenen-Editor locked</h1>
        <p style="color:#8a8a99;line-height:1.45;margin:0 0 16px">Private tool — open with your studio link (<code style="color:#f0a830">?studio=1</code>) once, then it stays unlocked on this browser.</p>
        <a href="../index.html" style="color:#f0a830">← Back to Synchronstudio</a>
      </div>
    </div>`;
} else {
  createRoot(rootEl).render(
    <StrictMode>
      <TooltipProvider delayDuration={1000} skipDelayDuration={0}>
        <App />
      </TooltipProvider>
    </StrictMode>,
  );
}
