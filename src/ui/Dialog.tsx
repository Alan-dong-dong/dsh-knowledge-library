import React, { useEffect, useRef } from 'react';
import { Icon } from './icons.js';

export function Dialog({ title, description, onClose, children }: { title: string; description: string; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const timer = setTimeout(() => ref.current?.querySelector<HTMLElement>('input,textarea,button')?.focus(), 0);
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current();
      if (event.key === 'Tab') {
        const elements = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select,a[href]') || []);
        const first = elements[0], last = elements[elements.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', key);
    return () => { clearTimeout(timer); document.removeEventListener('keydown', key); previous?.focus(); };
  }, []);
  return <div className="kl-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><div className="kl-dialog" role="dialog" aria-modal="true" aria-label={title} ref={ref}><header><div><h2>{title}</h2><p>{description}</p></div><button aria-label="关闭弹窗" onClick={onClose}><Icon name="close" /></button></header>{children}</div></div>;
}
