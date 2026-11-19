import {defineTheme} from '@astryxdesign/core/theme';
import {neutralTheme} from '@astryxdesign/theme-neutral';

export const ttsTheme = defineTheme({
  name: 'tts',
  extends: neutralTheme,
  color: {accent: '#e94560', neutralStyle: 'neutral'},
  typography: {
    scale: {base: 14, ratio: 1.2},
    body: {
      family: 'system-ui',
      fallbacks: '-apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif',
    },
    heading: {
      family: 'system-ui',
      fallbacks: '-apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif',
      weights: {3: 'bold', 4: 'bold'},
    },
    code: {
      family: 'ui-monospace',
      fallbacks:
        '"SF Mono", Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    },
  },
  tokens: {
    '--color-background-body': '#0b0b0c',
    '--color-background-surface': '#141416',
    '--color-background-card': '#1d1d20',
    '--color-background-popover': '#26262b',
    '--color-border': '#26262b',
    '--color-text-primary': '#f5f5f4',
    '--color-text-secondary': '#a1a1aa',
    '--color-success': '#34d399',
    '--color-warning': '#fbbf24',
    '--color-error': '#f87171',
    '--radius-element': '14px',
    '--radius-container': '16px',
  },
});
