/// <reference types="vite/client" />
import type { DetailedHTMLProps, HTMLAttributes } from 'react';

declare global {
  interface ImportMetaEnv {
    /** "1" swaps the network layer for src/mock/mockApi.ts. */
    readonly VITE_MOCK?: string;
    /** API base path, default "/api". */
    readonly VITE_API_BASE?: string;
  }
}

// <model-viewer> web component (loaded from the CDN in index.html).
declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'model-viewer': DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
        src: string;
        alt: string;
        poster?: string;
        'camera-controls'?: string;
        'auto-rotate'?: string;
        'shadow-intensity'?: string;
      };
    }
  }
}
