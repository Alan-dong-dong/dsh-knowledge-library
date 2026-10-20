import React from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-ui-layout/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import { App } from './ui/App.js';
import { LibraryIcon } from './ui/icons.js';
import styles from './ui/style.css';

export const inject = ['slots'];
export function apply(ctx: Context) {
  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.plugin = 'dsh-knowledge-library';
    style.textContent = styles;
    document.head.append(style);
    return () => style.remove();
  });
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'knowledge-library' }, () => <App />));
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: 'knowledge-library', order: 20, label: '资料库',
  }, () => <LibraryIcon size={20} />));
}
