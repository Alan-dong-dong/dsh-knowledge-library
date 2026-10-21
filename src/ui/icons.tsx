import React from 'react';
export function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    library: <><path d="M4 4h5v16H4zM12 4h3v16h-3zM17 5l3-1 4 15-3 1z" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></>,
    file: <><path d="M14 3H5v18h14V8zM14 3v5h5M8 13h8M8 17h6" /></>,
    web: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18" /></>,
    video: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m10 9 5 3-5 3z" /></>,
    note: <><path d="M12 4H5v16h14v-8M10 14l1-4 8-8 3 3-8 8z" /></>,
    folder: <path d="M3 6h7l2 3h9v11H3z" />,
    inbox: <><path d="M5 4h14l3 11v5H2v-5zM2 15h6l2 3h4l2-3h6" /></>,
    tag: <><path d="M3 3h9l9 9-9 9-9-9z" /><circle cx="8" cy="8" r="1" /></>,
    arrow: <path d="m9 5 7 7-7 7" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    upload: <><path d="M12 16V3m-5 5 5-5 5 5M3 15v6h18v-6" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v6l4 2" /></>,
    copy: <><rect x="8" y="8" width="12" height="13" rx="2" /><path d="M16 8V3H3v13h5" /></>,
    download: <><path d="M12 3v13m-5-5 5 5 5-5M3 17v4h18v-4" /></>,
    settings: <><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="3" /><circle cx="15" cy="17" r="3" /></>,
    trash: <><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" /></>,
    restore: <><path d="M3 10a9 9 0 1 1 2 9M3 4v6h6M12 7v5l3 2" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.file}</svg>;
}
export const LibraryIcon = ({ size }: { size?: number }) => <Icon name="library" size={size} />;
